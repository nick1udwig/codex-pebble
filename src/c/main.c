#include <pebble.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "message_keys.auto.h"

#define CODEX_MAX_JOBS 16
#define CODEX_ID_LENGTH 96
#define CODEX_TITLE_LENGTH 48
#define CODEX_DETAIL_LENGTH 96
#define CODEX_BODY_LENGTH 384
#define CODEX_REPLY_LENGTH 256
#define CODEX_STATUS_LENGTH 64
#define CODEX_DETAIL_TEXT_MEASURE_HEIGHT 1200
#define CODEX_DETAIL_TEXT_PADDING 4
#define CODEX_READY_INITIAL_DELAY_MS 300
#define CODEX_READY_RETRY_DELAY_MS 1000
#define CODEX_MENU_ROW_HEIGHT 44
#define CODEX_TOUCH_TAP_MAX_PX 15
#define CODEX_TOUCH_SWIPE_MIN_PX 40

#define CODEX_MSG_APP_READY "app_ready"
#define CODEX_MSG_REFRESH "refresh"
#define CODEX_MSG_LOAD_MORE "load_more"
#define CODEX_MSG_OPEN_CONFIG "open_config"
#define CODEX_MSG_DETAIL_REQUEST "detail_request"
#define CODEX_MSG_REPLY "reply"
#define CODEX_MSG_SETTINGS_STATE "settings_state"
#define CODEX_MSG_SYNC_STATUS "sync_status"
#define CODEX_MSG_JOB_CLEAR "job_clear"
#define CODEX_MSG_JOB_ITEM "job_item"
#define CODEX_MSG_JOB_COMPLETE "job_complete"
#define CODEX_MSG_DETAIL_UPDATE "detail_update"
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
  char body[CODEX_BODY_LENGTH];
  bool has_detail;
  bool loading_detail;
} CodexJob;

static Window *s_main_window;
static Window *s_detail_window;
static MenuLayer *s_menu_layer;
static ScrollLayer *s_detail_scroll_layer;
static TextLayer *s_status_layer;
static TextLayer *s_detail_body_layer;
static TextLayer *s_detail_footer_layer;
static AppTimer *s_ready_timer;
#if defined(PBL_MICROPHONE)
static DictationSession *s_dictation_session;
#endif

static CodexJob s_jobs[CODEX_MAX_JOBS];
static size_t s_job_count;
static int s_selected_job = -1;
static char s_selected_job_id[CODEX_ID_LENGTH];
static bool s_has_more;
static bool s_has_settings;
static bool s_received_state;
static CodexSyncState s_sync_state = CodexSyncDesynced;
static char s_status[CODEX_STATUS_LENGTH] = "Starting";
static bool s_touch_subscribed;
static bool s_touch_down;
static bool s_touch_dragged;
static int s_touch_down_x;
static int s_touch_down_y;
static int s_touch_last_y;

static void prv_send_message(const char *type, const char *payload);
static void prv_reload_menu(void);
static void prv_copy_string(char *dest, size_t dest_size, const char *src);
static CodexJob *prv_find_job_by_id(const char *id);
static CodexJob *prv_get_selected_job(void);
static void prv_update_detail_layers(void);
static void prv_update_detail_scroll(bool scroll_to_bottom);
static void prv_detail_click_config_provider(void *context);
static void prv_schedule_ready_timer(uint32_t delay_ms);
static void prv_touch_handler(const TouchEvent *event, void *context);

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

static int prv_iabs(int value) {
  return value < 0 ? -value : value;
}

static void prv_copy_payload_field(char *dest, size_t dest_size, const char *src) {
  size_t index;

  if (!dest || dest_size == 0) {
    return;
  }

  if (!src) {
    dest[0] = '\0';
    return;
  }

  for (index = 0; index + 1 < dest_size && src[index]; index += 1) {
    char c = src[index];
    dest[index] = (c == '|' || c == '\n' || c == '\r') ? ' ' : c;
  }
  dest[index] = '\0';
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
  s_has_more = false;
}

static CodexJob *prv_get_selected_job(void) {
  if (s_selected_job >= 0 && (size_t)s_selected_job < s_job_count) {
    return &s_jobs[s_selected_job];
  }
  if (s_selected_job_id[0]) {
    return prv_find_job_by_id(s_selected_job_id);
  }
  return NULL;
}

static void prv_handle_settings_state(const char *payload) {
  char buffer[128];
  char *cursor = buffer;

  prv_copy_string(buffer, sizeof(buffer), payload);
  s_has_settings = prv_string_is_truthy(prv_next_field(&cursor));
  s_received_state = true;

  if (!s_has_settings) {
    prv_clear_jobs();
    s_selected_job_id[0] = '\0';
    prv_set_status("Set server URL", CodexSyncDesynced);
  }

  prv_reload_menu();
}

static void prv_handle_job_item(const char *payload) {
  char buffer[320];
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
  prv_copy_string(job->body, sizeof(job->body), job->detail);
  job->has_detail = false;
  job->loading_detail = false;
  if (s_selected_job_id[0] && strcmp(job->id, s_selected_job_id) == 0) {
    s_selected_job = (int)(s_job_count - 1);
  }
}

static CodexJob *prv_find_job_by_id(const char *id) {
  size_t index;
  for (index = 0; index < s_job_count; index += 1) {
    if (strcmp(s_jobs[index].id, id) == 0) {
      return &s_jobs[index];
    }
  }
  return NULL;
}

static void prv_handle_job_complete(const char *payload) {
  char buffer[32];
  char *cursor = buffer;

  prv_copy_string(buffer, sizeof(buffer), payload);
  (void)prv_next_field(&cursor);
  s_has_more = prv_string_is_truthy(prv_next_field(&cursor));
  prv_set_status(s_job_count ? "Synced" : "No Codex jobs", s_sync_state);
  prv_reload_menu();
}

static void prv_handle_detail_update(const char *payload) {
  char buffer[512];
  char *cursor = buffer;
  const char *id;
  const char *body;
  CodexJob *job;

  prv_copy_string(buffer, sizeof(buffer), payload);
  id = prv_next_field(&cursor);
  body = prv_next_field(&cursor);
  job = prv_find_job_by_id(id);
  if (!job) {
    return;
  }

  prv_copy_string(job->body, sizeof(job->body), body[0] ? body : "No thread content");
  job->has_detail = true;
  job->loading_detail = false;
  prv_update_detail_layers();
}

static void prv_request_selected_detail(void) {
  CodexJob *job = prv_get_selected_job();
  if (!job) {
    return;
  }

  job->loading_detail = true;
  prv_copy_string(job->body, sizeof(job->body), "Loading thread...");
  prv_update_detail_layers();
  prv_send_message(CODEX_MSG_DETAIL_REQUEST, job->id);
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
    if (s_detail_footer_layer && strcmp(payload, "Syncing") != 0 && strcmp(payload, "Loading more") != 0) {
      text_layer_set_text(s_detail_footer_layer, payload);
    }
    prv_reload_menu();
  } else if (strcmp(type, CODEX_MSG_JOB_CLEAR) == 0) {
    prv_clear_jobs();
    prv_reload_menu();
  } else if (strcmp(type, CODEX_MSG_JOB_ITEM) == 0) {
    prv_handle_job_item(payload);
  } else if (strcmp(type, CODEX_MSG_JOB_COMPLETE) == 0) {
    prv_handle_job_complete(payload);
  } else if (strcmp(type, CODEX_MSG_DETAIL_UPDATE) == 0) {
    prv_handle_detail_update(payload);
  } else if (strcmp(type, CODEX_MSG_ERROR) == 0) {
    prv_set_status(payload[0] ? payload : "Sync failed", CodexSyncDesynced);
    if (s_detail_footer_layer) {
      text_layer_set_text(s_detail_footer_layer, s_status);
    }
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
  if (s_received_state) {
    return;
  }
  prv_send_message(CODEX_MSG_APP_READY, "");
  prv_schedule_ready_timer(CODEX_READY_RETRY_DELAY_MS);
}

static void prv_schedule_ready_timer(uint32_t delay_ms) {
  if (s_ready_timer || s_received_state) {
    return;
  }
  s_ready_timer = app_timer_register(delay_ms, prv_ready_timer_callback, NULL);
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
  return (uint16_t)(s_job_count + (s_has_more ? 1 : 0));
}

static int16_t prv_get_header_height(MenuLayer *menu_layer, uint16_t section_index, void *context) {
  return 0;
}

static int16_t prv_get_cell_height(MenuLayer *menu_layer, MenuIndex *cell_index, void *context) {
  (void)menu_layer;
  (void)cell_index;
  (void)context;

  return CODEX_MENU_ROW_HEIGHT;
}

static void prv_draw_row(GContext *ctx, const Layer *cell_layer, MenuIndex *cell_index, void *context) {
  if (!s_has_settings) {
    if (!s_received_state) {
      menu_cell_basic_draw(ctx, cell_layer, "Waiting for phone", "Select retries", NULL);
    } else {
      menu_cell_basic_draw(ctx, cell_layer, "Set server URL", "Select opens phone settings", NULL);
    }
    return;
  }

  if (s_job_count == 0) {
    const char *subtitle = s_received_state ? "Select refreshes" : "Waiting for phone";
    menu_cell_basic_draw(ctx, cell_layer, s_status, subtitle, NULL);
    return;
  }

  if ((size_t)cell_index->row >= s_job_count) {
    menu_cell_basic_draw(ctx, cell_layer, "Load more", "Fetch older threads", NULL);
    return;
  }

  CodexJob *job = &s_jobs[cell_index->row];
  menu_cell_basic_draw(ctx, cell_layer, job->title, job->detail, NULL);
}

static void prv_update_detail_layers(void) {
  CodexJob *job = prv_get_selected_job();
  bool scroll_to_bottom = false;

  if (s_detail_body_layer) {
    if (!job) {
      text_layer_set_text(s_detail_body_layer, "No details");
    } else if (job->loading_detail) {
      text_layer_set_text(s_detail_body_layer, "Loading thread...");
    } else {
      text_layer_set_text(s_detail_body_layer, job->has_detail ? job->body : job->detail);
      scroll_to_bottom = job->has_detail;
    }
  }
  prv_update_detail_scroll(scroll_to_bottom);
  if (s_detail_footer_layer) {
#if defined(PBL_MICROPHONE)
    text_layer_set_text(s_detail_footer_layer, job ? "Tap/Select: reply" : "");
#else
    text_layer_set_text(s_detail_footer_layer, "Reply unavailable");
#endif
  }
}

static void prv_update_detail_scroll(bool scroll_to_bottom) {
  Layer *body_layer;
  Layer *scroll_layer;
  GRect scroll_bounds;
  GRect body_frame;
  GSize text_size;
  int16_t content_height;
  int16_t bottom_offset;

  if (!s_detail_scroll_layer || !s_detail_body_layer) {
    return;
  }

  body_layer = text_layer_get_layer(s_detail_body_layer);
  scroll_layer = scroll_layer_get_layer(s_detail_scroll_layer);
  scroll_bounds = layer_get_bounds(scroll_layer);
  body_frame = layer_get_frame(body_layer);
  body_frame.origin = GPointZero;
  body_frame.size.w = scroll_bounds.size.w;
  body_frame.size.h = CODEX_DETAIL_TEXT_MEASURE_HEIGHT;
  layer_set_frame(body_layer, body_frame);

  text_size = text_layer_get_content_size(s_detail_body_layer);
  content_height = text_size.h + CODEX_DETAIL_TEXT_PADDING;
  if (content_height < scroll_bounds.size.h) {
    content_height = scroll_bounds.size.h;
  }

  body_frame.size.h = content_height;
  layer_set_frame(body_layer, body_frame);
  scroll_layer_set_content_size(s_detail_scroll_layer, GSize(scroll_bounds.size.w, content_height));

  if (scroll_to_bottom) {
    bottom_offset = content_height - scroll_bounds.size.h;
    if (bottom_offset < 0) {
      bottom_offset = 0;
    }
    scroll_layer_set_content_offset(s_detail_scroll_layer, GPoint(0, -bottom_offset), false);
  }
}

static void prv_scroll_detail_by(int dy) {
  Layer *scroll_layer;
  GRect bounds;
  GSize content_size;
  GPoint offset;
  int min_y;
  int next_y;

  if (!s_detail_scroll_layer) {
    return;
  }

  scroll_layer = scroll_layer_get_layer(s_detail_scroll_layer);
  bounds = layer_get_bounds(scroll_layer);
  content_size = scroll_layer_get_content_size(s_detail_scroll_layer);
  min_y = bounds.size.h - content_size.h;
  if (min_y > 0) {
    min_y = 0;
  }

  offset = scroll_layer_get_content_offset(s_detail_scroll_layer);
  next_y = offset.y + dy;
  if (next_y > 0) {
    next_y = 0;
  } else if (next_y < min_y) {
    next_y = min_y;
  }

  scroll_layer_set_content_offset(s_detail_scroll_layer, GPoint(0, next_y), false);
}

static void prv_detail_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  GRect footer_frame = GRect(0, bounds.size.h - 20, bounds.size.w, 20);
  GRect body_frame = GRect(4, 4, bounds.size.w - 8, bounds.size.h - 28);

  s_detail_scroll_layer = scroll_layer_create(body_frame);
  scroll_layer_set_callbacks(s_detail_scroll_layer, (ScrollLayerCallbacks) {
    .click_config_provider = prv_detail_click_config_provider,
  });
  scroll_layer_set_click_config_onto_window(s_detail_scroll_layer, window);
  layer_add_child(root, scroll_layer_get_layer(s_detail_scroll_layer));

  s_detail_body_layer = text_layer_create(GRect(0, 0, body_frame.size.w, body_frame.size.h));
  text_layer_set_font(s_detail_body_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_overflow_mode(s_detail_body_layer, GTextOverflowModeWordWrap);
  text_layer_set_background_color(s_detail_body_layer, GColorClear);
  scroll_layer_add_child(s_detail_scroll_layer, text_layer_get_layer(s_detail_body_layer));

  s_detail_footer_layer = text_layer_create(footer_frame);
  text_layer_set_font(s_detail_footer_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(s_detail_footer_layer, GTextAlignmentCenter);
  layer_add_child(root, text_layer_get_layer(s_detail_footer_layer));

  prv_update_detail_layers();
}

static void prv_detail_window_unload(Window *window) {
  text_layer_destroy(s_detail_body_layer);
  scroll_layer_destroy(s_detail_scroll_layer);
  text_layer_destroy(s_detail_footer_layer);
  s_detail_body_layer = NULL;
  s_detail_scroll_layer = NULL;
  s_detail_footer_layer = NULL;
}

static void prv_send_reply_text(const char *text) {
  CodexJob *job = prv_get_selected_job();
  const char *thread_id = job ? job->id : s_selected_job_id;
  char clean_text[CODEX_REPLY_LENGTH];
  char payload[CODEX_ID_LENGTH + CODEX_REPLY_LENGTH + 2];

  if (!thread_id[0] || !text || !text[0]) {
    return;
  }

  prv_copy_payload_field(clean_text, sizeof(clean_text), text);
  snprintf(payload, sizeof(payload), "%s|%s", thread_id, clean_text);
  if (s_detail_footer_layer) {
    text_layer_set_text(s_detail_footer_layer, "Sending...");
  }
  prv_send_message(CODEX_MSG_REPLY, payload);
}

#if defined(PBL_MICROPHONE)
static const char *prv_dictation_status_text(DictationSessionStatus status) {
  switch (status) {
    case DictationSessionStatusFailureTranscriptionRejected:
      return "Reply canceled";
    case DictationSessionStatusFailureNoSpeechDetected:
      return "No speech detected";
    case DictationSessionStatusFailureConnectivityError:
      return "Voice connection failed";
    case DictationSessionStatusFailureDisabled:
      return "Voice disabled";
    default:
      return "Voice input failed";
  }
}

static void prv_dictation_callback(DictationSession *session, DictationSessionStatus status, char *transcription,
                                   void *context) {
  (void)session;
  (void)context;

  if (status != DictationSessionStatusSuccess || !transcription || !transcription[0]) {
    if (s_detail_footer_layer) {
      text_layer_set_text(s_detail_footer_layer, prv_dictation_status_text(status));
    }
    return;
  }

  prv_send_reply_text(transcription);
}
#endif

static void prv_detail_select_handler(ClickRecognizerRef recognizer, void *context) {
  (void)recognizer;
  (void)context;

#if defined(PBL_MICROPHONE)
  if (!s_dictation_session) {
    if (s_detail_footer_layer) {
      text_layer_set_text(s_detail_footer_layer, "Voice unavailable");
    }
    return;
  }

  if (s_detail_footer_layer) {
    text_layer_set_text(s_detail_footer_layer, "Listening...");
  }
  if (dictation_session_start(s_dictation_session) != DictationSessionStatusSuccess && s_detail_footer_layer) {
    text_layer_set_text(s_detail_footer_layer, "Voice unavailable");
  }
#else
  if (s_detail_footer_layer) {
    text_layer_set_text(s_detail_footer_layer, "No microphone");
  }
#endif
}

static void prv_detail_click_config_provider(void *context) {
  (void)context;
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_detail_select_handler);
}

static void prv_select_click(MenuLayer *menu_layer, MenuIndex *cell_index, void *context) {
  if (!s_has_settings) {
    if (!s_received_state) {
      prv_set_status("Waiting for phone", CodexSyncDesynced);
      prv_send_message(CODEX_MSG_APP_READY, "");
      return;
    }
    prv_send_message(CODEX_MSG_OPEN_CONFIG, "");
    return;
  }

  if (s_job_count == 0) {
    prv_send_message(CODEX_MSG_REFRESH, "");
    return;
  }

  if ((size_t)cell_index->row >= s_job_count) {
    prv_set_status("Loading more", CodexSyncSyncing);
    prv_send_message(CODEX_MSG_LOAD_MORE, "");
    prv_reload_menu();
    return;
  }

  s_selected_job = cell_index->row;
  prv_copy_string(s_selected_job_id, sizeof(s_selected_job_id), s_jobs[s_selected_job].id);
  if (!s_detail_window) {
    s_detail_window = window_create();
    window_set_window_handlers(s_detail_window, (WindowHandlers){
      .load = prv_detail_window_load,
      .unload = prv_detail_window_unload,
    });
  }
  window_stack_push(s_detail_window, true);
  prv_request_selected_detail();
}

static bool prv_menu_index_from_touch(int x, int y, MenuIndex *index) {
  Layer *menu_layer_root;
  ScrollLayer *menu_scroll_layer;
  GRect menu_frame;
  GPoint offset;
  int content_y;
  int row;
  uint16_t row_count;

  if (!s_menu_layer || !index) {
    return false;
  }

  menu_layer_root = menu_layer_get_layer(s_menu_layer);
  menu_frame = layer_get_frame(menu_layer_root);
  if (!grect_contains_point(&menu_frame, &(GPoint){x, y})) {
    return false;
  }

  menu_scroll_layer = menu_layer_get_scroll_layer(s_menu_layer);
  offset = scroll_layer_get_content_offset(menu_scroll_layer);
  content_y = y - menu_frame.origin.y - offset.y;
  if (content_y < 0) {
    return false;
  }

  row = content_y / CODEX_MENU_ROW_HEIGHT;
  row_count = prv_get_num_rows(s_menu_layer, 0, NULL);
  if (row < 0 || row >= row_count) {
    return false;
  }

  index->section = 0;
  index->row = (uint16_t)row;
  return true;
}

static void prv_handle_main_touch_tap(int x, int y) {
  MenuIndex index;

  if (!prv_menu_index_from_touch(x, y, &index)) {
    return;
  }

  menu_layer_set_selected_index(s_menu_layer, index, MenuRowAlignCenter, false);
  prv_select_click(s_menu_layer, &index, NULL);
}

static void prv_handle_detail_touch_tap(int x, int y) {
  (void)x;
  (void)y;

  prv_detail_select_handler(NULL, NULL);
}

static void prv_touch_handler(const TouchEvent *event, void *context) {
  int dx;
  int dy;
  bool detail_active;

  (void)context;

  if (!event) {
    return;
  }

  detail_active = s_detail_scroll_layer != NULL;

  switch (event->type) {
    case TouchEvent_Touchdown:
      s_touch_down = true;
      s_touch_dragged = false;
      s_touch_down_x = event->x;
      s_touch_down_y = event->y;
      s_touch_last_y = event->y;
      break;

    case TouchEvent_PositionUpdate:
      if (!s_touch_down) {
        break;
      }
      if (prv_iabs(event->x - s_touch_down_x) > CODEX_TOUCH_TAP_MAX_PX ||
          prv_iabs(event->y - s_touch_down_y) > CODEX_TOUCH_TAP_MAX_PX) {
        s_touch_dragged = true;
      }
      if (detail_active) {
        dy = event->y - s_touch_last_y;
        if (dy != 0) {
          prv_scroll_detail_by(dy);
        }
      }
      s_touch_last_y = event->y;
      break;

    case TouchEvent_Liftoff:
      if (!s_touch_down) {
        break;
      }
      s_touch_down = false;
      dx = event->x - s_touch_down_x;
      dy = event->y - s_touch_down_y;

      if (detail_active) {
        if (prv_iabs(dx) > CODEX_TOUCH_SWIPE_MIN_PX && prv_iabs(dx) > prv_iabs(dy) && dx > 0) {
          window_stack_pop(true);
        } else if (prv_iabs(dx) < CODEX_TOUCH_TAP_MAX_PX && prv_iabs(dy) < CODEX_TOUCH_TAP_MAX_PX) {
          prv_handle_detail_touch_tap(s_touch_down_x, s_touch_down_y);
        } else if (!s_touch_dragged && prv_iabs(dy) > CODEX_TOUCH_SWIPE_MIN_PX) {
          prv_scroll_detail_by(dy);
        }
        break;
      }

      if (prv_iabs(dy) > CODEX_TOUCH_SWIPE_MIN_PX && prv_iabs(dy) > prv_iabs(dx) && s_menu_layer) {
        menu_layer_set_selected_next(s_menu_layer, dy > 0, MenuRowAlignCenter, true);
      } else if (prv_iabs(dx) < CODEX_TOUCH_TAP_MAX_PX && prv_iabs(dy) < CODEX_TOUCH_TAP_MAX_PX) {
        prv_handle_main_touch_tap(s_touch_down_x, s_touch_down_y);
      }
      break;

    default:
      break;
  }
}

static void prv_subscribe_touch(void) {
  if (s_touch_subscribed) {
    return;
  }

  touch_service_subscribe(prv_touch_handler, NULL);
  s_touch_subscribed = true;
}

static void prv_unsubscribe_touch(void) {
  if (!s_touch_subscribed) {
    return;
  }

  touch_service_unsubscribe();
  s_touch_subscribed = false;
  s_touch_down = false;
  s_touch_dragged = false;
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
    .get_cell_height = prv_get_cell_height,
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

  prv_subscribe_touch();
}

static void prv_main_window_unload(Window *window) {
  prv_unsubscribe_touch();
  menu_layer_destroy(s_menu_layer);
  text_layer_destroy(s_status_layer);
  s_menu_layer = NULL;
  s_status_layer = NULL;
}

static void prv_init(void) {
  app_message_register_inbox_received(prv_inbox_received);
  app_message_register_inbox_dropped(prv_inbox_dropped);
  app_message_register_outbox_failed(prv_outbox_failed);
  app_message_open(1024, 512);

#if defined(PBL_MICROPHONE)
  s_dictation_session = dictation_session_create(CODEX_REPLY_LENGTH, prv_dictation_callback, NULL);
  if (s_dictation_session) {
    dictation_session_enable_confirmation(s_dictation_session, false);
  }
#endif

  s_main_window = window_create();
  window_set_window_handlers(s_main_window, (WindowHandlers){
    .load = prv_main_window_load,
    .unload = prv_main_window_unload,
  });
  window_stack_push(s_main_window, true);

  prv_schedule_ready_timer(CODEX_READY_INITIAL_DELAY_MS);
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
#if defined(PBL_MICROPHONE)
  if (s_dictation_session) {
    dictation_session_destroy(s_dictation_session);
    s_dictation_session = NULL;
  }
#endif
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
