#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define main codex_watch_main
#include "../../src/c/main.c"
#undef main

static int s_failures;

static void expect_string(const char *name, const char *actual, const char *expected) {
  if (strcmp(actual ? actual : "", expected ? expected : "") != 0) {
    fprintf(stderr, "FAIL %s:\nexpected: %s\nactual:   %s\n", name, expected, actual);
    s_failures += 1;
  }
}

static void reset_watch_state(void) {
  memset(s_jobs, 0, sizeof(s_jobs));
  memset(s_detail_payload_buffer, 0, sizeof(s_detail_payload_buffer));
  memset(s_thread_body, 0, sizeof(s_thread_body));
  memset(s_thread_body_id, 0, sizeof(s_thread_body_id));
  memset(s_last_reply_thread_id, 0, sizeof(s_last_reply_thread_id));
  memset(s_last_reply_text, 0, sizeof(s_last_reply_text));
  s_thread_body_loaded = false;
  s_job_count = 0;
  s_selected_job = -1;
  s_selected_job_id[0] = '\0';
  s_has_more = false;
  s_has_settings = false;
  s_received_state = false;
  s_sync_state = CodexSyncDesynced;
  prv_copy_string(s_status, sizeof(s_status), "Starting");
  s_spinner_frame = 0;
  s_touch_subscribed = false;
  s_touch_down = false;
  s_touch_dragged = false;
  s_reply_in_flight = false;
  s_reply_retry_available = false;
  s_ready_timer = NULL;
  s_spinner_timer = NULL;
  s_main_window = NULL;
  s_detail_window = NULL;
  s_menu_layer = NULL;
  s_status_layer = NULL;
  s_detail_scroll_layer = NULL;
  s_detail_body_layer = NULL;
  s_detail_footer_layer = NULL;
}

static void install_detail_layers(ScrollLayer *scroll_layer, TextLayer *text_layer) {
  memset(scroll_layer, 0, sizeof(*scroll_layer));
  memset(text_layer, 0, sizeof(*text_layer));
  layer_set_frame(&scroll_layer->layer, GRect(0, 0, 144, 120));
  scroll_layer->content_size = GSize(144, 120);
  scroll_layer->content_offset = GPoint(0, -20);
  layer_set_frame(&text_layer->layer, GRect(0, 0, 144, 120));
  s_detail_scroll_layer = scroll_layer;
  s_detail_body_layer = text_layer;
}

static void test_copy_payload_field_sanitizes_separators(void) {
  char dest[32];
  prv_copy_payload_field(dest, sizeof(dest), "hello|there\nfriend\r!");
  expect_string("copy payload sanitizes separators", dest, "hello there friend !");
}

static void test_append_repeated_detail_page_is_not_dropped(void) {
  ScrollLayer scroll_layer;
  TextLayer text_layer;
  CodexJob job;

  reset_watch_state();
  install_detail_layers(&scroll_layer, &text_layer);
  memset(&job, 0, sizeof(job));
  prv_copy_string(job.id, sizeof(job.id), "thread-1");
  job.has_detail = true;
  prv_copy_string(s_thread_body_id, sizeof(s_thread_body_id), job.id);
  prv_copy_thread_body("Intro repeated\n\nMiddle page");

  prv_apply_detail_text(&job, "Intro repeated", CodexDetailMergeAppend, CodexDetailAnchorBottom);

  expect_string("append repeated detail page", s_thread_body, "Intro repeated\n\nMiddle page\n\nIntro repeated");
}

static void test_append_existing_suffix_is_not_duplicated(void) {
  ScrollLayer scroll_layer;
  TextLayer text_layer;
  CodexJob job;

  reset_watch_state();
  install_detail_layers(&scroll_layer, &text_layer);
  memset(&job, 0, sizeof(job));
  prv_copy_string(job.id, sizeof(job.id), "thread-1");
  job.has_detail = true;
  prv_copy_string(s_thread_body_id, sizeof(s_thread_body_id), job.id);
  prv_copy_thread_body("Older page\n\nNewest page");

  prv_apply_detail_text(&job, "Newest page", CodexDetailMergeAppend, CodexDetailAnchorBottom);

  expect_string("append existing suffix", s_thread_body, "Older page\n\nNewest page");
}

static void test_prepend_detail_page_preserves_order(void) {
  ScrollLayer scroll_layer;
  TextLayer text_layer;
  CodexJob job;

  reset_watch_state();
  install_detail_layers(&scroll_layer, &text_layer);
  memset(&job, 0, sizeof(job));
  prv_copy_string(job.id, sizeof(job.id), "thread-1");
  job.has_detail = true;
  prv_copy_string(s_thread_body_id, sizeof(s_thread_body_id), job.id);
  prv_copy_thread_body("Middle page\n\nNewest page");

  prv_apply_detail_text(&job, "Older page", CodexDetailMergePrepend, CodexDetailAnchorBottom);

  expect_string("prepend detail page", s_thread_body, "Older page\n\nMiddle page\n\nNewest page");
}

static void test_prepend_existing_prefix_is_not_duplicated(void) {
  ScrollLayer scroll_layer;
  TextLayer text_layer;
  CodexJob job;

  reset_watch_state();
  install_detail_layers(&scroll_layer, &text_layer);
  memset(&job, 0, sizeof(job));
  prv_copy_string(job.id, sizeof(job.id), "thread-1");
  job.has_detail = true;
  prv_copy_string(s_thread_body_id, sizeof(s_thread_body_id), job.id);
  prv_copy_thread_body("Older page\n\nMiddle page");

  prv_apply_detail_text(&job, "Older page", CodexDetailMergePrepend, CodexDetailAnchorBottom);

  expect_string("prepend existing prefix", s_thread_body, "Older page\n\nMiddle page");
}

static void test_append_overflow_keeps_newest_page(void) {
  ScrollLayer scroll_layer;
  TextLayer text_layer;
  CodexJob job;

  reset_watch_state();
  install_detail_layers(&scroll_layer, &text_layer);
  memset(&job, 0, sizeof(job));
  prv_copy_string(job.id, sizeof(job.id), "thread-1");
  job.has_detail = true;
  prv_copy_string(s_thread_body_id, sizeof(s_thread_body_id), job.id);
  memset(s_thread_body, 'A', sizeof(s_thread_body) - 1);
  s_thread_body[sizeof(s_thread_body) - 1] = '\0';
  s_thread_body_loaded = true;

  prv_apply_detail_text(&job, "Newest page", CodexDetailMergeAppend, CodexDetailAnchorBottom);

  if (!strstr(s_thread_body, "Newest page")) {
    fprintf(stderr, "FAIL append overflow keeps newest page: newest page missing\n");
    s_failures += 1;
  }
}

int main(void) {
  test_copy_payload_field_sanitizes_separators();
  test_append_repeated_detail_page_is_not_dropped();
  test_append_existing_suffix_is_not_duplicated();
  test_prepend_detail_page_preserves_order();
  test_prepend_existing_prefix_is_not_duplicated();
  test_append_overflow_keeps_newest_page();

  if (s_failures) {
    return EXIT_FAILURE;
  }
  puts("C watch logic tests passed");
  return EXIT_SUCCESS;
}
