import Dictation from "pebble/dictation";

export default class VoiceReply {
    constructor(callbacks = {}) {
        this.callbacks = callbacks;
        this.dictation = new Dictation({
            onReadable() {
                const text = this.read();
                if (callbacks.onText)
                    callbacks.onText(text);
            },
            onError(error) {
                if (callbacks.onError)
                    callbacks.onError(error);
            }
        });
    }

    start() {
        this.dictation.start();
    }
}
