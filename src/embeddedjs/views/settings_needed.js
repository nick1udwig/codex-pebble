export function drawSettingsNeeded(render, fonts, model) {
    const palette = {
        black: render.makeColor(0, 0, 0),
        white: render.makeColor(255, 255, 255),
        gray: render.makeColor(90, 90, 90),
        red: render.makeColor(180, 0, 0)
    };

    render.begin(0, 0, render.width, render.height);
    render.fillRectangle(palette.white, 0, 0, render.width, render.height);
    render.drawText("Codex Jobs", fonts.title, palette.black, 6, 7);
    render.drawText("Set server URL", fonts.body, palette.black, 6, 48);
    render.drawText("Open settings", fonts.body, palette.black, 6, 72);
    render.drawText("in phone app", fonts.body, palette.black, 6, 94);

    if (model && model.errorMessage)
        render.drawText(fit(render, model.errorMessage, fonts.small, render.width - 12), fonts.small, palette.red, 6, 124);
    else
        render.drawText("Select requests config", fonts.small, palette.gray, 6, 124);

    render.end();
}

export function drawConnecting(render, fonts, model) {
    const palette = {
        black: render.makeColor(0, 0, 0),
        white: render.makeColor(255, 255, 255),
        gray: render.makeColor(90, 90, 90),
        red: render.makeColor(180, 0, 0)
    };

    render.begin(0, 0, render.width, render.height);
    render.fillRectangle(palette.white, 0, 0, render.width, render.height);
    render.drawText("Codex Jobs", fonts.title, palette.black, 6, 7);
    render.drawText(model && model.message ? model.message : "Connecting...", fonts.body, palette.black, 6, 60);
    if (model && model.errorMessage)
        render.drawText(fit(render, model.errorMessage, fonts.small, render.width - 12), fonts.small, palette.red, 6, 90);
    render.drawText("Select retries", fonts.small, palette.gray, 6, 124);
    render.end();
}

function fit(render, text, font, maxWidth) {
    let value = text || "";
    if (render.getTextWidth(value, font) <= maxWidth)
        return value;

    while (value.length > 0 && render.getTextWidth(value + "...", font) > maxWidth)
        value = value.slice(0, -1);
    return value + "...";
}

export default {
    drawConnecting,
    drawSettingsNeeded
};
