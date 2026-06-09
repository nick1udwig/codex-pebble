export function drawDetail(render, fonts, model) {
    const palette = makePalette(render);
    const width = render.width;
    const height = render.height;

    render.begin(0, 0, width, height);
    render.fillRectangle(palette.white, 0, 0, width, height);

    if (!model.job) {
        render.drawText("Job missing", fonts.title, palette.black, 6, 6);
        render.end();
        return;
    }

    render.drawText(fit(render, model.job.title, fonts.title, width - 12), fonts.title, palette.black, 6, 5);
    render.drawText(statusText(model.job), fonts.body, statusColor(model.job, palette), 6, 31);

    const progress = model.job.progress || model.job.cwd || "No recent summary";
    drawWrapped(render, fonts.small, palette.black, progress, 6, 56, width - 12, 3);

    if (model.replyText)
        drawWrapped(render, fonts.small, palette.gray, "Reply: " + model.replyText, 6, 108, width - 12, 2);
    if (model.errorMessage)
        render.drawText(fit(render, model.errorMessage, fonts.small, width - 12), fonts.small, palette.red, 6, 127);

    drawBottomBar(render, fonts, palette, model);
    render.end();
}

export function drawDictation(render, fonts, model) {
    const palette = makePalette(render);
    const width = render.width;
    const height = render.height;

    render.begin(0, 0, width, height);
    render.fillRectangle(palette.white, 0, 0, width, height);
    render.drawText(model.title || "Voice reply", fonts.title, palette.black, 6, 6);

    if (model.listening) {
        render.drawText("Listening...", fonts.body, palette.black, 6, 52);
    } else {
        drawWrapped(render, fonts.body, palette.black, model.replyText || "", 6, 40, width - 12, 4);
        if (model.errorMessage)
            render.drawText(fit(render, model.errorMessage, fonts.small, width - 12), fonts.small, palette.red, 6, 122);
        render.drawText("Select sends", fonts.small, palette.gray, 6, height - 18);
    }

    render.end();
}

function drawBottomBar(render, fonts, palette, model) {
    const y = render.height - 18;
    const left = model.canAck ? "Up Ack" : "Up Refresh";
    render.drawText(left, fonts.small, palette.gray, 4, y);
    render.drawText("Select Voice", fonts.small, palette.gray, 66, y);
}

function statusText(job) {
    if (job.waitingOnApproval)
        return "Needs approval";
    if (job.kind === "active")
        return "Running";
    if (job.kind === "systemError")
        return "Error";
    if (job.kind === "completed")
        return "Done - unacked";
    if (job.kind === "failed")
        return "Failed - unacked";
    if (job.kind === "interrupted")
        return "Interrupted - unacked";
    return job.kind || "Unknown";
}

function statusColor(job, palette) {
    if (job.waitingOnApproval || job.kind === "systemError" || job.kind === "failed")
        return palette.red;
    return palette.black;
}

function drawWrapped(render, font, color, text, x, y, maxWidth, maxLines) {
    const words = String(text || "").split(/\s+/);
    let line = "";
    let lineCount = 0;

    for (const word of words) {
        const next = line ? line + " " + word : word;
        if (render.getTextWidth(next, font) > maxWidth && line) {
            render.drawText(fit(render, line, font, maxWidth), font, color, x, y + (lineCount * 17));
            line = word;
            lineCount++;
            if (lineCount >= maxLines)
                return;
        } else {
            line = next;
        }
    }

    if (lineCount < maxLines && line)
        render.drawText(fit(render, line, font, maxWidth), font, color, x, y + (lineCount * 17));
}

function fit(render, text, font, maxWidth) {
    let value = text || "";
    if (render.getTextWidth(value, font) <= maxWidth)
        return value;

    while (value.length > 0 && render.getTextWidth(value + "...", font) > maxWidth)
        value = value.slice(0, -1);
    return value + "...";
}

function makePalette(render) {
    return {
        black: render.makeColor(0, 0, 0),
        white: render.makeColor(255, 255, 255),
        gray: render.makeColor(90, 90, 90),
        red: render.makeColor(180, 0, 0)
    };
}
