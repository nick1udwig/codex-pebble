export default class VoiceReply {
    constructor(callbacks = {}) {
        this.callbacks = callbacks;
    }

    start() {
        if (this.callbacks.onError)
            this.callbacks.onError("Voice reply unavailable");
    }
}
