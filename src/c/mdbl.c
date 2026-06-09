#include <pebble.h>

int main(void) {
  Window *w = window_create();
  window_stack_push(w, true);

  ModdableCreationRecord creation = {
      .recordSize = sizeof(ModdableCreationRecord),
      .stack = 4096,
      .slot = 40960,
      .chunk = 8192,
      .flags = 0,
  };
  moddable_createMachine(&creation);

  window_destroy(w);
}
