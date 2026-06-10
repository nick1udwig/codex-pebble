#include <pebble.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "message_keys.auto.h"

#define CODEX_MAX_JOBS 8
#define CODEX_ID_LENGTH 48
#define CODEX_TITLE_LENGTH 48
#define CODEX_DETAIL_LENGTH 96
#define CODEX_STATUS_LENGTH 64

#define CODEX_MSG_APP_READY "app_ready"
#define CODEX_MSG_REFRESH "refresh"
#define CODEX_MSG_OPEN_CONFIG "open_config"
#define CODEX_MSG_SETTINGS_STATE "settings_state"
#define CODEX_MSG_SYNC_STATUS "sync_status"
#define CODEX_MSG_JOB_CLEAR "job_clear"
#define CODEX_MSG_JOB_ITEM "job_item"
#define CODEX_MSG_JOB_COMPLETE "job_complete"
#define CODEX_MSG_ERROR "error"

typedef enum {
  CodexSyncDesynced = 0,
  CodexSyncSyncing = 1,
  CodexSyncSynced = 2,
} CodexSyncState;

typedef struct {
  char id[CODEX_ID_LENGTH];
  char kind[16];
  char title[CODEX_TITLE_LENGTH];
  char detail[CODEX_DETAIL_LENGTH];
} CodexJob;

static Window *s_main_window;
static Window *s_detail_window;
static MenuLayer *s_menu_layer;
static TextLayer *s_status_layer;
static TextLayer *s_detail_title_layer;
static TextLayer *s_detail_body_layer;
static AppTimer *s_ready_timer;

static CodexJob s_jobs[CODEX_MAX_JOBS];
static size_t s_job_count;
static int s_selected_job = -1;
static bool s_has_settings;
static bool s_received_state;
static CodexSyncState s_sync_state = CodexSyncDesynced;
static char s_status[CODEX_STATUS_LENGTH] = "Starting";

static void prv_send_message(const char *type, const char *payload);
static void prv_reload_menu(void);
static void prv_copy_string(char *dest, size_t dest_size, const char *src);

static void prv_copy_string(char *dest, size_t dest_size, const char *src) {
  if (!dest || dest_size == 0) {
    return;
  }

  snprintf(dest, dest_size, "%s", src ? src : "");
}

static const char *prv_next_field(char **cursor) {
  char *start;
  char *separator;

  if (!cursor || !*cursor) {
    return "";
  }

  start = *cursor;
  separator = strchr(start, '|');
  if (separator) {
    *separator = '\0';
    *cursor = separator + 1;
  } else {
    *cursor = NULL;
  }

  return start;
}

static bool prv_string_is_truthy(const char *value) {
  return value && value[0] == '1';
}

static void prv_set_status(const char *status, CodexSyncState sync_state) {
  s_sync_state = sync_state;
  prv_copy_string(s_status, sizeof(s_status), status);
  if (s_status_layer) {
    text_layer_set_text(s_status_layer, s_status);
  }
}

static void prv_clear_jobs(void) {
  s_job_count = 0;
  s_selected_job = -1;
}

static void prv_handle_settings_state(const char *payload) {
  char buffer[128];
  char *cursor = buffer;

  prv_copy_string(buffer, sizeof(buffer), payload);
  s_has_settings = prv_string_is_truthy(prv_next_field(&cursor));
  s_received_state = true;

  if (!s_has_settings) {
    prv_clear_jobs();
    prv_set_status("Set server URL", CodexSyncDesynced);
  }

  prv_reload_menu();
}

static void prv_handle_job_item(const char *payload) {
  char buffer[256];
  char *cursor = buffer;
  CodexJob *job;

  if (s_job_count >= CODEX_MAX_JOBS) {
    return;
  }

  prv_copy_string(buffer, sizeof(buffer), payload);
  job = &s_jobs[s_job_count++];
  prv_copy_string(job->id, sizeof(job->id), prv_next_field(&cursor));
  prv_copy_string(job->kind, sizeof(job->kind), prv_next_field(&cursor));
  prv_copy_string(job->title, sizeof(job->title), prv_next_field(&cursor));
  prv_copy_string(job->detail, sizeof(job->detail), prv_next_field(&cursor));
}

static void prv_inbox_received(DictionaryIterator *iter, void *context) {
  Tuple *type_tuple = dict_find(iter, MESSAGE_KEY_MessageType);
  Tuple *payload_tuple = dict_find(iter, MESSAGE_KEY_Payload);
  Tuple *sync_tuple = dict_find(iter, MESSAGE_KEY_SyncState);
  const char *type = type_tuple ? type_tuple->value->cstring : "";
  const char *payload = payload_tuple ? payload_tuple->value->cstring : "";

  if (sync_tuple) {
    s_sync_state = (CodexSyncState)sync_tuple->value->int32;
  }

  if (strcmp(type, CODEX_MSG_SETTINGS_STATE) == 0) {
    prv_handle_settings_state(payload);
  } else if (strcmp(type, CODEX_MSG_SYNC_STATUS) == 0) {
    prv_set_status(payload, s_sync_state);
    prv_reload_menu();
  } else if (strcmp(type, CODEX_MSG_JOB_CLEAR) == 0) {
    prv_clear_jobs();
    prv_reload_menu();
  } else if (strcmp(type, CODEX_MSG_JOB_ITEM) == 0) {
    prv_handle_job_item(payload);
  } else if (strcmp(type, CODEX_MSG_JOB_COMPLETE) == 0) {
    prv_set_status(s_job_count ? "Synced" : "No Codex jobs", s_sync_state);
    prv_reload_menu();
  } else if (strcmp(type, CODEX_MSG_ERROR) == 0) {
    prv_set_status(payload[0] ? payload : "Sync failed", CodexSyncDesynced);
    prv_reload_menu();
  }
}

static void prv_inbox_dropped(AppMessageResult reason, void *context) {
  prv_set_status("Phone message dropped", CodexSyncDesynced);
  prv_reload_menu();
}

static void prv_outbox_failed(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  prv_set_status("Phone link not ready", CodexSyncDesynced);
  prv_reload_menu();
}

static void prv_send_message(const char *type, const char *payload) {
  DictionaryIterator *iter;
  AppMessageResult result = app_message_outbox_begin(&iter);
  if (result != APP_MSG_OK || !iter) {
    return;
  }

  dict_write_cstring(iter, MESSAGE_KEY_MessageType, type ? type : "");
  if (payload) {
    dict_write_cstring(iter, MESSAGE_KEY_Payload, payload);
  }
  dict_write_int32(iter, MESSAGE_KEY_SyncState, s_sync_state);
  app_message_outbox_send();
}

static void prv_ready_timer_callback(void *context) {
  s_ready_timer = NULL;
  prv_send_message(CODEX_MSG_APP_READY, "");
}

static uint16_t prv_get_num_sections(MenuLayer *menu_layer, void *context) {
  return 1;
}

static uint16_t prv_get_num_rows(MenuLayer *menu_layer, uint16_t section_index, void *context) {
  if (!s_has_settings) {
    return 1;
  }
  if (s_job_count == 0) {
    return 1;
  }
  return (uint16_t)s_job_count;
}

static int16_t prv_get_header_height(MenuLayer *menu_layer, uint16_t section_index, void *context) {
  return 0;
}

static void prv_draw_row(GContext *ctx, const Layer *cell_layer, MenuIndex *cell_index, void *context) {
  if (!s_has_settings) {
    menu_cell_basic_draw(ctx, cell_layer, "Set server URL", "Select opens phone settings", NULL);
    return;
  }

  if (s_job_count == 0) {
    const char *subtitle = s_received_state ? "Select refreshes" : "Waiting for phone";
    menu_cell_basic_draw(ctx, cell_layer, s_status, subtitle, NULL);
    return;
  }

  CodexJob *job = &s_jobs[cell_index->row];
  menu_cell_basic_draw(ctx, cell_layer, job->title, job->detail, NULL);
}

static void prv_detail_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  GRect title_frame = GRect(4, 4, bounds.size.w - 8, 42);
  GRect body_frame = GRect(4, 48, bounds.size.w - 8, bounds.size.h - 52);
  CodexJob *job = (s_selected_job >= 0 && (size_t)s_selected_job < s_job_count) ? &s_jobs[s_selected_job] : NULL;

  s_detail_title_layer = text_layer_create(title_frame);
  text_layer_set_font(s_detail_title_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_overflow_mode(s_detail_title_layer, GTextOverflowModeTrailingEllipsis);
  text_layer_set_text(s_detail_title_layer, job ? job->title : "Codex Job");
  layer_add_child(root, text_layer_get_layer(s_detail_title_layer));

  s_detail_body_layer = text_layer_create(body_frame);
  text_layer_set_font(s_detail_body_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_overflow_mode(s_detail_body_layer, GTextOverflowModeWordWrap);
  text_layer_set_text(s_detail_body_layer, job ? job->detail : "No details");
  layer_add_child(root, text_layer_get_layer(s_detail_body_layer));
}

static void prv_detail_window_unload(Window *window) {
  text_layer_destroy(s_detail_title_layer);
  text_layer_destroy(s_detail_body_layer);
  s_detail_title_layer = NULL;
  s_detail_body_layer = NULL;
}

static void prv_select_click(MenuLayer *menu_layer, MenuIndex *cell_index, void *context) {
  if (!s_has_settings) {
    prv_send_message(CODEX_MSG_OPEN_CONFIG, "");
    return;
  }

  if (s_job_count == 0) {
    prv_send_message(CODEX_MSG_REFRESH, "");
    return;
  }

  s_selected_job = cell_index->row;
  if (!s_detail_window) {
    s_detail_window = window_create();
    window_set_window_handlers(s_detail_window, (WindowHandlers){
      .load = prv_detail_window_load,
      .unload = prv_detail_window_unload,
    });
  }
  window_stack_push(s_detail_window, true);
}

static void prv_reload_menu(void) {
  if (s_status_layer) {
    text_layer_set_text(s_status_layer, s_status);
  }
  if (s_menu_layer) {
    menu_layer_reload_data(s_menu_layer);
  }
}

static void prv_main_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  GRect status_frame = GRect(0, bounds.size.h - 20, bounds.size.w, 20);
  GRect menu_frame = GRect(0, 0, bounds.size.w, bounds.size.h - 20);

  s_menu_layer = menu_layer_create(menu_frame);
  menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks){
    .get_num_sections = prv_get_num_sections,
    .get_num_rows = prv_get_num_rows,
    .get_header_height = prv_get_header_height,
    .draw_row = prv_draw_row,
    .select_click = prv_select_click,
  });
  menu_layer_set_click_config_onto_window(s_menu_layer, window);
  layer_add_child(root, menu_layer_get_layer(s_menu_layer));

  s_status_layer = text_layer_create(status_frame);
  text_layer_set_font(s_status_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(s_status_layer, GTextAlignmentCenter);
  text_layer_set_text(s_status_layer, s_status);
  layer_add_child(root, text_layer_get_layer(s_status_layer));
}

static void prv_main_window_unload(Window *window) {
  menu_layer_destroy(s_menu_layer);
  text_layer_destroy(s_status_layer);
  s_menu_layer = NULL;
  s_status_layer = NULL;
}

static void prv_init(void) {
  app_message_register_inbox_received(prv_inbox_received);
  app_message_register_inbox_dropped(prv_inbox_dropped);
  app_message_register_outbox_failed(prv_outbox_failed);
  app_message_open(512, 512);

  s_main_window = window_create();
  window_set_window_handlers(s_main_window, (WindowHandlers){
    .load = prv_main_window_load,
    .unload = prv_main_window_unload,
  });
  window_stack_push(s_main_window, true);

  s_ready_timer = app_timer_register(300, prv_ready_timer_callback, NULL);
}

static void prv_deinit(void) {
  if (s_ready_timer) {
    app_timer_cancel(s_ready_timer);
    s_ready_timer = NULL;
  }
  if (s_detail_window) {
    window_destroy(s_detail_window);
    s_detail_window = NULL;
  }
  if (s_main_window) {
    window_destroy(s_main_window);
    s_main_window = NULL;
  }
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
