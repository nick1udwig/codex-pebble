#ifndef CODEX_TEST_PEBBLE_H
#define CODEX_TEST_PEBBLE_H

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

typedef struct Window Window;
typedef struct Layer Layer;
typedef struct MenuLayer MenuLayer;
typedef struct ScrollLayer ScrollLayer;
typedef struct TextLayer TextLayer;
typedef struct AppTimer AppTimer;
typedef struct DictionaryIterator DictionaryIterator;
typedef void *ClickRecognizerRef;
typedef int GContext;
typedef int GFont;
typedef int GColor;
typedef int GTextOverflowMode;
typedef int GTextAlignment;

typedef struct {
  int16_t x;
  int16_t y;
} GPoint;

typedef struct {
  int16_t w;
  int16_t h;
} GSize;

typedef struct {
  GPoint origin;
  GSize size;
} GRect;

#define GPoint(x_value, y_value) ((GPoint){(x_value), (y_value)})
#define GSize(width, height) ((GSize){(width), (height)})
#define GRect(x_value, y_value, width, height) ((GRect){GPoint((x_value), (y_value)), GSize((width), (height))})
#define GPointZero GPoint(0, 0)

#define GColorClear 0
#define GTextOverflowModeWordWrap 0
#define GTextAlignmentCenter 0
#define FONT_KEY_GOTHIC_14 "gothic-14"
#define BUTTON_ID_UP 1
#define BUTTON_ID_DOWN 2
#define BUTTON_ID_SELECT 3
#define MenuRowAlignCenter 0

struct Layer {
  GRect frame;
  GRect bounds;
  bool hidden;
};

struct Window {
  Layer root;
};

struct ScrollLayer {
  Layer layer;
  GSize content_size;
  GPoint content_offset;
};

struct TextLayer {
  Layer layer;
  const char *text;
};

struct MenuLayer {
  Layer layer;
  ScrollLayer scroll_layer;
};

struct AppTimer {
  bool canceled;
};

typedef struct {
  uint16_t section;
  uint16_t row;
} MenuIndex;

typedef struct {
  uint16_t (*get_num_sections)(MenuLayer *, void *);
  uint16_t (*get_num_rows)(MenuLayer *, uint16_t, void *);
  int16_t (*get_cell_height)(MenuLayer *, MenuIndex *, void *);
  int16_t (*get_header_height)(MenuLayer *, uint16_t, void *);
  void (*draw_row)(GContext *, const Layer *, MenuIndex *, void *);
  void (*select_click)(MenuLayer *, MenuIndex *, void *);
} MenuLayerCallbacks;

typedef struct {
  void (*click_config_provider)(void *);
} ScrollLayerCallbacks;

typedef struct {
  void (*load)(Window *);
  void (*unload)(Window *);
} WindowHandlers;

typedef enum {
  TouchEvent_Touchdown,
  TouchEvent_PositionUpdate,
  TouchEvent_Liftoff,
} TouchEventType;

typedef struct {
  TouchEventType type;
  int x;
  int y;
} TouchEvent;

typedef enum {
  APP_MSG_OK = 0,
  APP_MSG_ERROR = 1,
} AppMessageResult;

typedef union {
  char *cstring;
  int32_t int32;
} TupleValue;

typedef struct {
  TupleValue *value;
} Tuple;

struct DictionaryIterator {
  int unused;
};

static inline bool grect_contains_point(const GRect *rect, const GPoint *point) {
  return rect && point &&
         point->x >= rect->origin.x &&
         point->x < rect->origin.x + rect->size.w &&
         point->y >= rect->origin.y &&
         point->y < rect->origin.y + rect->size.h;
}

static inline Layer *window_get_root_layer(Window *window) {
  return window ? &window->root : NULL;
}

static inline GRect layer_get_bounds(const Layer *layer) {
  return layer ? layer->bounds : GRect(0, 0, 0, 0);
}

static inline GRect layer_get_frame(const Layer *layer) {
  return layer ? layer->frame : GRect(0, 0, 0, 0);
}

static inline void layer_set_frame(Layer *layer, GRect frame) {
  if (layer) {
    layer->frame = frame;
    layer->bounds = GRect(0, 0, frame.size.w, frame.size.h);
  }
}

static inline void layer_set_hidden(Layer *layer, bool hidden) {
  if (layer) {
    layer->hidden = hidden;
  }
}

static inline void layer_add_child(Layer *parent, Layer *child) {
  (void)parent;
  (void)child;
}

static inline Window *window_create(void) {
  Window *window = (Window *)calloc(1, sizeof(Window));
  if (window) {
    window->root.frame = GRect(0, 0, 144, 168);
    window->root.bounds = GRect(0, 0, 144, 168);
  }
  return window;
}

static inline void window_destroy(Window *window) {
  free(window);
}

static inline void window_set_window_handlers(Window *window, WindowHandlers handlers) {
  (void)window;
  (void)handlers;
}

static inline void window_stack_push(Window *window, bool animated) {
  (void)window;
  (void)animated;
}

static inline void window_stack_pop(bool animated) {
  (void)animated;
}

static inline MenuLayer *menu_layer_create(GRect frame) {
  MenuLayer *menu_layer = (MenuLayer *)calloc(1, sizeof(MenuLayer));
  if (menu_layer) {
    layer_set_frame(&menu_layer->layer, frame);
  }
  return menu_layer;
}

static inline void menu_layer_destroy(MenuLayer *menu_layer) {
  free(menu_layer);
}

static inline Layer *menu_layer_get_layer(MenuLayer *menu_layer) {
  return menu_layer ? &menu_layer->layer : NULL;
}

static inline ScrollLayer *menu_layer_get_scroll_layer(MenuLayer *menu_layer) {
  return menu_layer ? &menu_layer->scroll_layer : NULL;
}

static inline void menu_layer_set_callbacks(MenuLayer *menu_layer, void *context, MenuLayerCallbacks callbacks) {
  (void)menu_layer;
  (void)context;
  (void)callbacks;
}

static inline void menu_layer_set_click_config_onto_window(MenuLayer *menu_layer, Window *window) {
  (void)menu_layer;
  (void)window;
}

static inline void menu_layer_reload_data(MenuLayer *menu_layer) {
  (void)menu_layer;
}

static inline void menu_layer_set_selected_index(MenuLayer *menu_layer, MenuIndex index, int align, bool animated) {
  (void)menu_layer;
  (void)index;
  (void)align;
  (void)animated;
}

static inline void menu_layer_set_selected_next(MenuLayer *menu_layer, bool up, int align, bool animated) {
  (void)menu_layer;
  (void)up;
  (void)align;
  (void)animated;
}

static inline void menu_cell_basic_draw(GContext *ctx, const Layer *cell_layer, const char *title, const char *subtitle, void *icon) {
  (void)ctx;
  (void)cell_layer;
  (void)title;
  (void)subtitle;
  (void)icon;
}

static inline ScrollLayer *scroll_layer_create(GRect frame) {
  ScrollLayer *scroll_layer = (ScrollLayer *)calloc(1, sizeof(ScrollLayer));
  if (scroll_layer) {
    layer_set_frame(&scroll_layer->layer, frame);
    scroll_layer->content_size = frame.size;
  }
  return scroll_layer;
}

static inline void scroll_layer_destroy(ScrollLayer *scroll_layer) {
  free(scroll_layer);
}

static inline Layer *scroll_layer_get_layer(ScrollLayer *scroll_layer) {
  return scroll_layer ? &scroll_layer->layer : NULL;
}

static inline void scroll_layer_set_shadow_hidden(ScrollLayer *scroll_layer, bool hidden) {
  (void)scroll_layer;
  (void)hidden;
}

static inline void scroll_layer_set_callbacks(ScrollLayer *scroll_layer, ScrollLayerCallbacks callbacks) {
  (void)scroll_layer;
  (void)callbacks;
}

static inline void scroll_layer_set_click_config_onto_window(ScrollLayer *scroll_layer, Window *window) {
  (void)scroll_layer;
  (void)window;
}

static inline void scroll_layer_add_child(ScrollLayer *scroll_layer, Layer *child) {
  (void)scroll_layer;
  (void)child;
}

static inline void scroll_layer_set_content_size(ScrollLayer *scroll_layer, GSize size) {
  if (scroll_layer) {
    scroll_layer->content_size = size;
  }
}

static inline GSize scroll_layer_get_content_size(ScrollLayer *scroll_layer) {
  return scroll_layer ? scroll_layer->content_size : GSize(0, 0);
}

static inline void scroll_layer_set_content_offset(ScrollLayer *scroll_layer, GPoint point, bool animated) {
  (void)animated;
  if (scroll_layer) {
    scroll_layer->content_offset = point;
  }
}

static inline GPoint scroll_layer_get_content_offset(ScrollLayer *scroll_layer) {
  return scroll_layer ? scroll_layer->content_offset : GPointZero;
}

static inline TextLayer *text_layer_create(GRect frame) {
  TextLayer *text_layer = (TextLayer *)calloc(1, sizeof(TextLayer));
  if (text_layer) {
    layer_set_frame(&text_layer->layer, frame);
  }
  return text_layer;
}

static inline void text_layer_destroy(TextLayer *text_layer) {
  free(text_layer);
}

static inline Layer *text_layer_get_layer(TextLayer *text_layer) {
  return text_layer ? &text_layer->layer : NULL;
}

static inline void text_layer_set_text(TextLayer *text_layer, const char *text) {
  if (text_layer) {
    text_layer->text = text;
  }
}

static inline void text_layer_set_font(TextLayer *text_layer, GFont font) {
  (void)text_layer;
  (void)font;
}

static inline void text_layer_set_overflow_mode(TextLayer *text_layer, GTextOverflowMode mode) {
  (void)text_layer;
  (void)mode;
}

static inline void text_layer_set_background_color(TextLayer *text_layer, GColor color) {
  (void)text_layer;
  (void)color;
}

static inline void text_layer_set_text_alignment(TextLayer *text_layer, GTextAlignment alignment) {
  (void)text_layer;
  (void)alignment;
}

static inline GSize text_layer_get_content_size(TextLayer *text_layer) {
  return text_layer ? text_layer->layer.frame.size : GSize(0, 0);
}

static inline GFont fonts_get_system_font(const char *key) {
  (void)key;
  return 0;
}

static inline void window_single_click_subscribe(int button_id, void (*handler)(ClickRecognizerRef, void *)) {
  (void)button_id;
  (void)handler;
}

static inline void touch_service_subscribe(void (*handler)(const TouchEvent *, void *), void *context) {
  (void)handler;
  (void)context;
}

static inline void touch_service_unsubscribe(void) {
}

static inline AppTimer *app_timer_register(uint32_t delay_ms, void (*callback)(void *), void *context) {
  (void)delay_ms;
  (void)callback;
  (void)context;
  return (AppTimer *)calloc(1, sizeof(AppTimer));
}

static inline void app_timer_cancel(AppTimer *timer) {
  if (timer) {
    timer->canceled = true;
    free(timer);
  }
}

static inline void app_message_register_inbox_received(void (*handler)(DictionaryIterator *, void *)) {
  (void)handler;
}

static inline void app_message_register_inbox_dropped(void (*handler)(AppMessageResult, void *)) {
  (void)handler;
}

static inline void app_message_register_outbox_failed(void (*handler)(DictionaryIterator *, AppMessageResult, void *)) {
  (void)handler;
}

static inline AppMessageResult app_message_open(uint32_t inbox_size, uint32_t outbox_size) {
  (void)inbox_size;
  (void)outbox_size;
  return APP_MSG_OK;
}

static inline AppMessageResult app_message_outbox_begin(DictionaryIterator **iter) {
  static DictionaryIterator iterator;
  if (iter) {
    *iter = &iterator;
  }
  return APP_MSG_OK;
}

static inline AppMessageResult app_message_outbox_send(void) {
  return APP_MSG_OK;
}

static inline Tuple *dict_find(DictionaryIterator *iter, uint32_t key) {
  (void)iter;
  (void)key;
  return NULL;
}

static inline void dict_write_cstring(DictionaryIterator *iter, uint32_t key, const char *value) {
  (void)iter;
  (void)key;
  (void)value;
}

static inline void dict_write_int32(DictionaryIterator *iter, uint32_t key, int32_t value) {
  (void)iter;
  (void)key;
  (void)value;
}

static inline void vibes_short_pulse(void) {
}

static inline void vibes_double_pulse(void) {
}

static inline void app_event_loop(void) {
}

#endif
