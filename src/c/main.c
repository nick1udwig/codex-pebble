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
#define CODEX_BODY_LENGTH 640
#define CODEX_THREAD_BODY_LENGTH 16384
#define CODEX_DETAIL_PAYLOAD_LENGTH 768
#define CODEX_REPLY_LENGTH 256
#define CODEX_STATUS_LENGTH 64
#define CODEX_DETAIL_TEXT_MEASURE_HEIGHT 24000
#define CODEX_DETAIL_TEXT_PADDING 4
#define CODEX_READY_INITIAL_DELAY_MS 300
#define CODEX_READY_RETRY_DELAY_MS 1000
#define CODEX_MENU_ROW_HEIGHT 44
#define CODEX_TOUCH_TAP_MAX_PX 15
#define CODEX_TOUCH_SWIPE_MIN_PX 40
#define CODEX_SPINNER_INTERVAL_MS 650

#define CODEX_MSG_APP_READY "app_ready"
#define CODEX_MSG_REFRESH "refresh"
#define CODEX_MSG_LOAD_MORE "load_more"
#define CODEX_MSG_OPEN_CONFIG "open_config"
#define CODEX_MSG_DETAIL_REQUEST "detail_request"
#define CODEX_MSG_DETAIL_SCROLL "detail_scroll"
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

typedef enum {
  CodexDetailAnchorBottom = 0,
  CodexDetailAnchorTop = 1,
  CodexDetailAnchorKeep = 2,
} CodexDetailAnchor;

typedef enum {
  CodexDetailMergeReplace = 0,
  CodexDetailMergePrepend = 1,
  CodexDetailMergeAppend = 2,
} CodexDetailMerge;

typedef enum {
  CodexDetailRequestNone = 0,
  CodexDetailRequestOlder = 1,
  CodexDetailRequestNewer = 2,
} CodexDetailRequest;

typedef struct {
  char id[CODEX_ID_LENGTH];
  char kind[16];
  char title[CODEX_TITLE_LENGTH];
  char detail[CODEX_DETAIL_LENGTH];
  char body[CODEX_BODY_LENGTH];
  bool has_detail;
  bool loading_detail;
  bool detail_has_prev;
  bool detail_has_next;
  bool detail_page_pending;
  bool unread_done;
  CodexDetailRequest detail_pending_request;
  CodexDetailAnchor detail_anchor;
} CodexJob;

static Window *s_main_window;
static Window *s_detail_window;
static MenuLayer *s_menu_layer;
static ScrollLayer *s_detail_scroll_layer;
static TextLayer *s_status_layer;
static TextLayer *s_detail_body_layer;
static TextLayer *s_detail_footer_layer;
static AppTimer *s_ready_timer;
static AppTimer *s_spinner_timer;
#if defined(PBL_MICROPHONE)
static DictationSession *s_dictation_session;
#endif

static CodexJob s_jobs[CODEX_MAX_JOBS];
static char s_detail_payload_buffer[CODEX_DETAIL_PAYLOAD_LENGTH];
static char s_thread_body[CODEX_THREAD_BODY_LENGTH];
static char s_thread_body_merge_buffer[CODEX_THREAD_BODY_LENGTH];
static char s_thread_body_id[CODEX_ID_LENGTH];
static char s_last_reply_thread_id[CODEX_ID_LENGTH];
static char s_last_reply_text[CODEX_REPLY_LENGTH];
static bool s_thread_body_loaded;
static size_t s_job_count;
static int s_selected_job = -1;
static char s_selected_job_id[CODEX_ID_LENGTH];
static bool s_has_more;
static bool s_has_settings;
static bool s_received_state;
static CodexSyncState s_sync_state = CodexSyncDesynced;
static char s_status[CODEX_STATUS_LENGTH] = "Starting";
static uint8_t s_spinner_frame;
static bool s_touch_subscribed;
static bool s_touch_down;
static bool s_touch_dragged;
static bool s_reply_in_flight;
static bool s_reply_retry_available;
static int s_touch_down_x;
static int s_touch_down_y;
static int s_touch_last_y;

static bool prv_send_message(const char *type, const char *payload);
static void prv_reload_menu(void);
static void prv_update_spinner_timer(void);
static void prv_update_status_layer(void);
static void prv_copy_string(char *dest, size_t dest_size, const char *src);
static CodexJob *prv_find_job_by_id(const char *id);
static CodexJob *prv_get_selected_job(void);
static void prv_update_detail_layers(void);
static void prv_update_detail_scroll(CodexDetailAnchor anchor);
static void prv_detail_click_config_provider(void *context);
static void prv_schedule_ready_timer(uint32_t delay_ms);
static void prv_touch_handler(const TouchEvent *event, void *context);
static bool prv_is_detail_anchor(const char *value);
static bool prv_job_is_working_kind(const char *kind);
static bool prv_job_needs_attention_kind(const char *kind);
static char prv_spinner_char(void);
static bool prv_has_activity(void);
static void prv_format_job_title(CodexJob *job, char *dest, size_t dest_size);
static void prv_prepare_detail_load(CodexJob *job);
static void prv_clear_reply_state(const char *thread_id);
static void prv_mark_reply_retry_available(void);
static bool prv_retry_reply(void);
static const char *prv_selected_detail_text(CodexJob *job);
static void prv_apply_detail_text(CodexJob *job, const char *body, CodexDetailMerge merge, CodexDetailAnchor anchor);

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

static bool prv_job_is_working_kind(const char *kind) {
  return kind && (strcmp(kind, "working") == 0 || strcmp(kind, "active") == 0 || strcmp(kind, "running") == 0);
}

static bool prv_job_needs_attention_kind(const char *kind) {
  return kind && (strcmp(kind, "approval") == 0 || strcmp(kind, "input") == 0 ||
                  strcmp(kind, "error") == 0 || strcmp(kind, "systemError") == 0);
}

static char prv_spinner_char(void) {
  static const char frames[] = "|/-\\";
  return frames[s_spinner_frame % (sizeof(frames) - 1)];
}

static bool prv_has_activity(void) {
  size_t index;

  if (s_sync_state == CodexSyncSyncing || s_reply_in_flight) {
    return true;
  }

  for (index = 0; index < s_job_count; index += 1) {
    if (prv_job_is_working_kind(s_jobs[index].kind) || s_jobs[index].loading_detail || s_jobs[index].detail_page_pending) {
      return true;
    }
  }
  return false;
}

static void prv_format_job_title(CodexJob *job, char *dest, size_t dest_size) {
  if (!job) {
    prv_copy_string(dest, dest_size, "");
    return;
  }

  if (prv_job_needs_attention_kind(job->kind)) {
    snprintf(dest, dest_size, "! %s", job->title);
  } else if (prv_job_is_working_kind(job->kind)) {
    snprintf(dest, dest_size, "%c %s", prv_spinner_char(), job->title);
  } else if (job->unread_done) {
    snprintf(dest, dest_size, ". %s", job->title);
  } else {
    prv_copy_string(dest, dest_size, job->title);
  }
}

static bool prv_is_detail_anchor(const char *value) {
  return value && (strcmp(value, "top") == 0 || strcmp(value, "bottom") == 0 || strcmp(value, "keep") == 0);
}

static CodexDetailAnchor prv_parse_detail_anchor(const char *value) {
  if (value && strcmp(value, "top") == 0) {
    return CodexDetailAnchorTop;
  }
  if (value && strcmp(value, "keep") == 0) {
    return CodexDetailAnchorKeep;
  }
  return CodexDetailAnchorBottom;
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

static void prv_copy_thread_body(const char *text) {
  prv_copy_string(s_thread_body, sizeof(s_thread_body), text && text[0] ? text : "No thread content");
  s_thread_body_loaded = true;
}

static void prv_prepare_detail_load(CodexJob *job) {
  if (!job) {
    return;
  }

  job->loading_detail = true;
  job->detail_page_pending = false;
  job->detail_pending_request = CodexDetailRequestNone;
  prv_copy_string(job->body, sizeof(job->body), "Loading thread...");
  prv_copy_string(s_thread_body_id, sizeof(s_thread_body_id), job->id);
  s_thread_body[0] = '\0';
  s_thread_body_loaded = false;
}

static void prv_clear_reply_state(const char *thread_id) {
  if (thread_id && s_last_reply_thread_id[0] && strcmp(thread_id, s_last_reply_thread_id) != 0) {
    return;
  }

  s_reply_in_flight = false;
  s_reply_retry_available = false;
  s_last_reply_thread_id[0] = '\0';
  s_last_reply_text[0] = '\0';
  prv_update_spinner_timer();
}

static void prv_mark_reply_retry_available(void) {
  if (!s_reply_in_flight || !s_last_reply_thread_id[0] || !s_last_reply_text[0]) {
    return;
  }

  s_reply_in_flight = false;
  s_reply_retry_available = true;
  prv_update_spinner_timer();
  if (s_detail_footer_layer) {
    text_layer_set_text(s_detail_footer_layer, "Select: retry reply");
  }
}

static void prv_join_thread_body(const char *first, const char *second) {
  first = first ? first : "";
  second = second ? second : "";
  if (first[0] && second[0]) {
    snprintf(s_thread_body_merge_buffer, sizeof(s_thread_body_merge_buffer), "%s\n\n%s", first, second);
  } else {
    snprintf(s_thread_body_merge_buffer, sizeof(s_thread_body_merge_buffer), "%s%s", first, second);
  }
  prv_copy_thread_body(s_thread_body_merge_buffer);
}

static const char *prv_selected_detail_text(CodexJob *job) {
  if (job && job->has_detail && s_thread_body_loaded && strcmp(job->id, s_thread_body_id) == 0) {
    return s_thread_body;
  }
  if (job && job->has_detail) {
    return job->body;
  }
  return job ? job->detail : "No details";
}

static int prv_clamp_detail_offset(int offset_y) {
  Layer *scroll_layer;
  GRect bounds;
  GSize content_size;
  int min_y;

  if (!s_detail_scroll_layer) {
    return offset_y;
  }

  scroll_layer = scroll_layer_get_layer(s_detail_scroll_layer);
  bounds = layer_get_bounds(scroll_layer);
  content_size = scroll_layer_get_content_size(s_detail_scroll_layer);
  min_y = bounds.size.h - content_size.h;
  if (min_y > 0) {
    min_y = 0;
  }
  if (offset_y > 0) {
    return 0;
  }
  if (offset_y < min_y) {
    return min_y;
  }
  return offset_y;
}

static void prv_apply_detail_text(CodexJob *job, const char *body, CodexDetailMerge merge, CodexDetailAnchor anchor) {
  const char *safe_body = body ? body : "";
  GPoint old_offset = GPointZero;
  GSize old_content_size = GSize(0, 0);
  GSize new_content_size;
  int next_offset_y;
  bool can_preserve_offset = s_detail_scroll_layer && s_detail_body_layer && job && job->has_detail &&
                             s_thread_body_loaded && strcmp(job->id, s_thread_body_id) == 0;
  bool hide_until_positioned = s_detail_body_layer && (!can_preserve_offset || merge == CodexDetailMergeReplace);

  if (!job) {
    return;
  }

  prv_copy_string(s_thread_body_id, sizeof(s_thread_body_id), job->id);
  if (!can_preserve_offset || merge == CodexDetailMergeReplace || !s_thread_body[0]) {
    prv_copy_thread_body(safe_body);
  } else if (merge == CodexDetailMergePrepend) {
    if (safe_body[0] && strstr(s_thread_body, safe_body) == s_thread_body) {
      merge = CodexDetailMergeReplace;
    } else {
      old_offset = scroll_layer_get_content_offset(s_detail_scroll_layer);
      old_content_size = scroll_layer_get_content_size(s_detail_scroll_layer);
      prv_join_thread_body(safe_body, s_thread_body);
    }
  } else {
    if (safe_body[0] && strstr(s_thread_body, safe_body)) {
      merge = CodexDetailMergeReplace;
    } else {
      old_offset = scroll_layer_get_content_offset(s_detail_scroll_layer);
      old_content_size = scroll_layer_get_content_size(s_detail_scroll_layer);
      prv_join_thread_body(s_thread_body, safe_body);
    }
  }

  prv_copy_string(job->body, sizeof(job->body), safe_body[0] ? safe_body : "No thread content");
  job->has_detail = true;
  job->loading_detail = false;

  if (!s_detail_body_layer) {
    return;
  }

  if (hide_until_positioned) {
    layer_set_hidden(text_layer_get_layer(s_detail_body_layer), true);
  }
  text_layer_set_text(s_detail_body_layer, s_thread_body);
  prv_update_detail_scroll(can_preserve_offset ? CodexDetailAnchorKeep : anchor);

  if (!can_preserve_offset || merge == CodexDetailMergeReplace) {
    if (hide_until_positioned) {
      layer_set_hidden(text_layer_get_layer(s_detail_body_layer), false);
    }
    return;
  }

  new_content_size = scroll_layer_get_content_size(s_detail_scroll_layer);
  if (merge == CodexDetailMergePrepend) {
    next_offset_y = old_offset.y - (new_content_size.h - old_content_size.h);
  } else {
    next_offset_y = old_offset.y;
  }
  scroll_layer_set_content_offset(s_detail_scroll_layer, GPoint(0, prv_clamp_detail_offset(next_offset_y)), false);
  if (hide_until_positioned) {
    layer_set_hidden(text_layer_get_layer(s_detail_body_layer), false);
  }
}

static void prv_set_status(const char *status, CodexSyncState sync_state) {
  s_sync_state = sync_state;
  prv_copy_string(s_status, sizeof(s_status), status);
  prv_update_status_layer();
  prv_update_spinner_timer();
}

static void prv_update_status_layer(void) {
  static char status_text[CODEX_STATUS_LENGTH + 4];

  if (s_status_layer) {
    if (s_sync_state == CodexSyncSyncing) {
      snprintf(status_text, sizeof(status_text), "%c %s", prv_spinner_char(), s_status);
      text_layer_set_text(s_status_layer, status_text);
    } else {
      text_layer_set_text(s_status_layer, s_status);
    }
  }
}

static void prv_spinner_timer_callback(void *context) {
  (void)context;
  s_spinner_timer = NULL;
  s_spinner_frame = (uint8_t)((s_spinner_frame + 1) % 4);
  prv_reload_menu();
}

static void prv_update_spinner_timer(void) {
  bool should_spin = prv_has_activity();

  if (should_spin && !s_spinner_timer) {
    s_spinner_timer = app_timer_register(CODEX_SPINNER_INTERVAL_MS, prv_spinner_timer_callback, NULL);
  } else if (!should_spin && s_spinner_timer) {
    app_timer_cancel(s_spinner_timer);
    s_spinner_timer = NULL;
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
  char id[CODEX_ID_LENGTH];
  char kind[16];
  char title[CODEX_TITLE_LENGTH];
  char detail[CODEX_DETAIL_LENGTH];
  CodexJob *job;
  bool is_new_job = false;
  bool was_working = false;
  bool needs_attention_before = false;
  bool needs_attention_after = false;
  bool is_selected_thread = false;

  prv_copy_string(buffer, sizeof(buffer), payload);
  prv_copy_string(id, sizeof(id), prv_next_field(&cursor));
  prv_copy_string(kind, sizeof(kind), prv_next_field(&cursor));
  prv_copy_string(title, sizeof(title), prv_next_field(&cursor));
  prv_copy_string(detail, sizeof(detail), prv_next_field(&cursor));

  if (!id[0]) {
    return;
  }

  job = prv_find_job_by_id(id);
  if (!job) {
    if (s_job_count >= CODEX_MAX_JOBS) {
      return;
    }
    job = &s_jobs[s_job_count++];
    is_new_job = true;
  } else {
    was_working = prv_job_is_working_kind(job->kind);
    needs_attention_before = prv_job_needs_attention_kind(job->kind);
  }

  is_selected_thread = s_selected_job_id[0] && strcmp(id, s_selected_job_id) == 0;
  needs_attention_after = prv_job_needs_attention_kind(kind);

  prv_copy_string(job->id, sizeof(job->id), id);
  prv_copy_string(job->kind, sizeof(job->kind), kind);
  prv_copy_string(job->title, sizeof(job->title), title);
  prv_copy_string(job->detail, sizeof(job->detail), detail);
  if (is_new_job || !job->has_detail) {
    prv_copy_string(job->body, sizeof(job->body), job->detail);
  }
  if (is_new_job) {
    job->has_detail = false;
    job->loading_detail = false;
    job->detail_has_prev = false;
    job->detail_has_next = false;
    job->detail_page_pending = false;
    job->unread_done = false;
    job->detail_pending_request = CodexDetailRequestNone;
    job->detail_anchor = CodexDetailAnchorBottom;
  } else if (is_selected_thread) {
    job->unread_done = false;
  } else if (was_working && !prv_job_is_working_kind(kind) && !needs_attention_after) {
    job->unread_done = true;
    vibes_short_pulse();
  } else if (!needs_attention_before && needs_attention_after) {
    vibes_double_pulse();
  }
  if (is_selected_thread) {
    s_selected_job = (int)(job - s_jobs);
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
  char *cursor = s_detail_payload_buffer;
  const char *id;
  const char *anchor_or_body;
  const char *has_prev;
  const char *has_next;
  const char *body;
  CodexJob *job;
  bool page_has_prev = false;
  bool page_has_next = false;
  CodexDetailAnchor page_anchor = CodexDetailAnchorBottom;
  CodexDetailMerge merge = CodexDetailMergeReplace;

  prv_copy_string(s_detail_payload_buffer, sizeof(s_detail_payload_buffer), payload);
  id = prv_next_field(&cursor);
  anchor_or_body = prv_next_field(&cursor);
  job = prv_find_job_by_id(id);
  if (!job) {
    return;
  }

  if (prv_is_detail_anchor(anchor_or_body)) {
    has_prev = prv_next_field(&cursor);
    has_next = prv_next_field(&cursor);
    body = prv_next_field(&cursor);
    page_anchor = prv_parse_detail_anchor(anchor_or_body);
    page_has_prev = prv_string_is_truthy(has_prev);
    page_has_next = prv_string_is_truthy(has_next);
  } else {
    body = anchor_or_body;
  }

  if (job->detail_page_pending && job->detail_pending_request == CodexDetailRequestOlder) {
    merge = CodexDetailMergePrepend;
    job->detail_anchor = CodexDetailAnchorKeep;
    job->detail_has_prev = page_has_prev;
  } else if (job->detail_page_pending && job->detail_pending_request == CodexDetailRequestNewer) {
    merge = CodexDetailMergeAppend;
    job->detail_anchor = CodexDetailAnchorKeep;
    job->detail_has_next = page_has_next;
  } else {
    merge = CodexDetailMergeReplace;
    job->detail_anchor = page_anchor;
    job->detail_has_prev = page_has_prev;
    job->detail_has_next = page_has_next;
  }

  prv_apply_detail_text(job, body, merge, page_anchor);
  job->unread_done = false;
  job->detail_page_pending = false;
  job->detail_pending_request = CodexDetailRequestNone;
  if (s_detail_footer_layer) {
    text_layer_set_text(s_detail_footer_layer,
                        s_reply_retry_available && strcmp(job->id, s_last_reply_thread_id) == 0 ? "Select: retry reply" : "Select: reply");
  }
}

static void prv_request_detail_page(CodexJob *job, const char *direction) {
  char payload[CODEX_ID_LENGTH + 12];

  if (!job || !direction || job->detail_page_pending) {
    return;
  }
  if (strcmp(direction, "older") == 0 && !job->detail_has_prev) {
    return;
  }
  if (strcmp(direction, "newer") == 0 && !job->detail_has_next) {
    return;
  }

  snprintf(payload, sizeof(payload), "%s|%s", job->id, direction);
  job->detail_page_pending = true;
  job->detail_pending_request = strcmp(direction, "older") == 0 ? CodexDetailRequestOlder : CodexDetailRequestNewer;
  if (s_detail_footer_layer) {
    text_layer_set_text(s_detail_footer_layer, strcmp(direction, "older") == 0 ? "Loading older" : "Loading newer");
  }
  prv_send_message(CODEX_MSG_DETAIL_SCROLL, payload);
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
    if (strcmp(payload, "Reply sent") == 0) {
      prv_clear_reply_state(NULL);
    }
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
    prv_mark_reply_retry_available();
    prv_set_status(payload[0] ? payload : "Sync failed", CodexSyncDesynced);
    if (s_detail_footer_layer) {
      text_layer_set_text(s_detail_footer_layer, s_reply_retry_available ? "Select: retry reply" : s_status);
    }
    prv_reload_menu();
  }
}

static void prv_inbox_dropped(AppMessageResult reason, void *context) {
  prv_set_status("Phone message dropped", CodexSyncDesynced);
  prv_reload_menu();
}

static void prv_outbox_failed(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  CodexJob *job = prv_get_selected_job();
  if (job) {
    job->detail_page_pending = false;
    job->detail_pending_request = CodexDetailRequestNone;
  }
  prv_mark_reply_retry_available();
  prv_set_status("Phone link not ready", CodexSyncDesynced);
  prv_reload_menu();
}

static bool prv_send_message(const char *type, const char *payload) {
  DictionaryIterator *iter;
  AppMessageResult result = app_message_outbox_begin(&iter);
  if (result != APP_MSG_OK || !iter) {
    return false;
  }

  dict_write_cstring(iter, MESSAGE_KEY_MessageType, type ? type : "");
  if (payload) {
    dict_write_cstring(iter, MESSAGE_KEY_Payload, payload);
  }
  dict_write_int32(iter, MESSAGE_KEY_SyncState, s_sync_state);
  return app_message_outbox_send() == APP_MSG_OK;
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
  char title[CODEX_TITLE_LENGTH + 4];
  prv_format_job_title(job, title, sizeof(title));
  menu_cell_basic_draw(ctx, cell_layer, title, job->detail, NULL);
}

static void prv_update_detail_layers(void) {
  CodexJob *job = prv_get_selected_job();
  CodexDetailAnchor anchor = CodexDetailAnchorKeep;

  if (s_detail_body_layer) {
    if (!job) {
      layer_set_hidden(text_layer_get_layer(s_detail_body_layer), false);
      text_layer_set_text(s_detail_body_layer, "No details");
    } else if (job->loading_detail) {
      text_layer_set_text(s_detail_body_layer, "");
      layer_set_hidden(text_layer_get_layer(s_detail_body_layer), true);
      anchor = CodexDetailAnchorTop;
    } else {
      layer_set_hidden(text_layer_get_layer(s_detail_body_layer), false);
      text_layer_set_text(s_detail_body_layer, prv_selected_detail_text(job));
      anchor = job->has_detail ? job->detail_anchor : CodexDetailAnchorTop;
    }
  }
  prv_update_detail_scroll(anchor);
  if (s_detail_footer_layer) {
#if defined(PBL_MICROPHONE)
    if (!job) {
      text_layer_set_text(s_detail_footer_layer, "");
    } else if (job->loading_detail) {
      text_layer_set_text(s_detail_footer_layer, "Loading thread");
    } else if (job->detail_page_pending) {
      text_layer_set_text(s_detail_footer_layer, job->detail_pending_request == CodexDetailRequestOlder ? "Loading older" : "Loading newer");
    } else if (s_reply_retry_available && strcmp(job->id, s_last_reply_thread_id) == 0) {
      text_layer_set_text(s_detail_footer_layer, "Select: retry reply");
    } else {
      text_layer_set_text(s_detail_footer_layer, "Select: reply");
    }
#else
    text_layer_set_text(s_detail_footer_layer, "Reply unavailable");
#endif
  }
}

static void prv_update_detail_scroll(CodexDetailAnchor anchor) {
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

  if (anchor == CodexDetailAnchorBottom) {
    bottom_offset = content_height - scroll_bounds.size.h;
    if (bottom_offset < 0) {
      bottom_offset = 0;
    }
    scroll_layer_set_content_offset(s_detail_scroll_layer, GPoint(0, -bottom_offset), false);
  } else if (anchor == CodexDetailAnchorTop) {
    scroll_layer_set_content_offset(s_detail_scroll_layer, GPointZero, false);
  }
}

static void prv_scroll_detail_by(int dy) {
  Layer *scroll_layer;
  GRect bounds;
  GSize content_size;
  GPoint offset;
  CodexJob *job;
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
  job = prv_get_selected_job();
  if (next_y > 0) {
    next_y = 0;
    if (dy > 0) {
      prv_request_detail_page(job, "older");
    }
  } else if (next_y < min_y) {
    next_y = min_y;
    if (dy < 0) {
      prv_request_detail_page(job, "newer");
    }
  }

  scroll_layer_set_content_offset(s_detail_scroll_layer, GPoint(0, next_y), false);
}

static void prv_detail_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  GRect footer_frame = GRect(0, bounds.size.h - 20, bounds.size.w, 20);
  GRect body_frame = GRect(4, 4, bounds.size.w - 8, bounds.size.h - 28);

  s_detail_scroll_layer = scroll_layer_create(body_frame);
  scroll_layer_set_shadow_hidden(s_detail_scroll_layer, true);
  scroll_layer_set_callbacks(s_detail_scroll_layer, (ScrollLayerCallbacks) {
    .click_config_provider = prv_detail_click_config_provider,
  });
  scroll_layer_set_click_config_onto_window(s_detail_scroll_layer, window);
  layer_add_child(root, scroll_layer_get_layer(s_detail_scroll_layer));

  s_detail_body_layer = text_layer_create(GRect(0, 0, body_frame.size.w, body_frame.size.h));
  text_layer_set_font(s_detail_body_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
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
  prv_copy_string(s_last_reply_thread_id, sizeof(s_last_reply_thread_id), thread_id);
  prv_copy_string(s_last_reply_text, sizeof(s_last_reply_text), clean_text);
  s_reply_in_flight = true;
  s_reply_retry_available = false;
  prv_update_spinner_timer();
  snprintf(payload, sizeof(payload), "%s|%s", thread_id, clean_text);
  if (s_detail_footer_layer) {
    text_layer_set_text(s_detail_footer_layer, "Sending...");
  }
  if (!prv_send_message(CODEX_MSG_REPLY, payload)) {
    prv_mark_reply_retry_available();
    if (s_detail_footer_layer) {
      text_layer_set_text(s_detail_footer_layer, "Select: retry reply");
    }
  }
}

static bool prv_retry_reply(void) {
  char payload[CODEX_ID_LENGTH + CODEX_REPLY_LENGTH + 2];

  if (!s_reply_retry_available || !s_last_reply_thread_id[0] || !s_last_reply_text[0]) {
    return false;
  }

  snprintf(payload, sizeof(payload), "%s|%s", s_last_reply_thread_id, s_last_reply_text);
  s_reply_in_flight = true;
  s_reply_retry_available = false;
  prv_update_spinner_timer();
  if (s_detail_footer_layer) {
    text_layer_set_text(s_detail_footer_layer, "Retrying...");
  }
  if (!prv_send_message(CODEX_MSG_REPLY, payload)) {
    prv_mark_reply_retry_available();
  }
  return true;
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
  CodexJob *job = prv_get_selected_job();
  if (job && s_reply_retry_available && strcmp(job->id, s_last_reply_thread_id) == 0 && prv_retry_reply()) {
    return;
  }

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

static void prv_detail_up_handler(ClickRecognizerRef recognizer, void *context) {
  (void)recognizer;
  (void)context;
  prv_scroll_detail_by(42);
}

static void prv_detail_down_handler(ClickRecognizerRef recognizer, void *context) {
  (void)recognizer;
  (void)context;
  prv_scroll_detail_by(-42);
}

static void prv_detail_click_config_provider(void *context) {
  (void)context;
  window_single_click_subscribe(BUTTON_ID_UP, prv_detail_up_handler);
  window_single_click_subscribe(BUTTON_ID_DOWN, prv_detail_down_handler);
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
  s_jobs[s_selected_job].unread_done = false;
  prv_prepare_detail_load(&s_jobs[s_selected_job]);
  if (!s_detail_window) {
    s_detail_window = window_create();
    window_set_window_handlers(s_detail_window, (WindowHandlers){
      .load = prv_detail_window_load,
      .unload = prv_detail_window_unload,
    });
  }
  window_stack_push(s_detail_window, true);
  prv_send_message(CODEX_MSG_DETAIL_REQUEST, s_selected_job_id);
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
  prv_update_status_layer();
  if (s_menu_layer) {
    menu_layer_reload_data(s_menu_layer);
  }
  prv_update_spinner_timer();
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
  if (s_spinner_timer) {
    app_timer_cancel(s_spinner_timer);
    s_spinner_timer = NULL;
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
