export function drawDashboard(render, fonts, model) {
    const palette = makePalette(render);
    const width = render.width;
    const height = render.height;
    const rowHeight = 34;
    const top = 30;

    render.begin(0, 0, width, height);
    render.fillRectangle(palette.white, 0, 0, width, height);
    render.drawText("Codex Jobs", fonts.title, palette.black, 6, 4);

    if (model.syncing)
        render.drawText("...", fonts.small, palette.gray, width - 24, 8);
    else if (model.stale)
        render.drawText("stale", fonts.small, palette.red, width - 40, 8);

    if (!model.jobs.length) {
        const message = model.errorMessage || "No active jobs";
        render.drawText(fit(render, message, fonts.body, width - 14), fonts.body, palette.black, 7, 54);
        if (model.connectionState)
            render.drawText(fit(render, model.connectionState, fonts.small, width - 14), fonts.small, palette.gray, 7, 80);
        render.end();
        return;
    }

    for (let i = 0; i < model.jobs.length; i++) {
        const y = top + (i * rowHeight);
        drawJobRow(render, fonts, palette, model.jobs[i], y, width, i === model.selectedIndex);
    }

    if (model.hasMore) {
        const y = top + (model.jobs.length * rowHeight);
        const selected = model.selectedIndex === model.jobs.length;
        if (selected)
            render.fillRectangle(palette.black, 0, y - 2, width, rowHeight);
        render.drawText(model.expanded ? "Show less" : "See more...", fonts.body, selected ? palette.white : palette.gray, 10, y + 6);
    }

    render.end();
}

function drawJobRow(render, fonts, palette, job, y, width, selected) {
    const fg = selected ? palette.white : palette.black;
    const sub = selected ? palette.white : palette.gray;

    if (selected)
        render.fillRectangle(palette.black, 0, y - 2, width, 32);

    render.drawText(statusMark(job), fonts.body, fg, 6, y + 1);
    render.drawText(fit(render, job.title, fonts.body, width - 34, true), fonts.body, fg, 26, y + 1);
    render.drawText(fit(render, statusText(job), fonts.small, width - 36), fonts.small, sub, 26, y + 19);
}

function statusMark(job) {
    if (job.waitingOnApproval || job.kind === "systemError" || job.kind === "failed")
        return "!";
    if (job.kind === "completed")
        return "OK";
    if (job.kind === "interrupted")
        return "-";
    return "*";
}

function statusText(job) {
    if (job.waitingOnApproval)
        return "Needs approval";
    if (job.kind === "active")
        return job.progress ? "Running - " + job.progress : "Running";
    if (job.kind === "systemError")
        return "Error";
    if (job.kind === "completed")
        return job.progress ? "Done - " + job.progress : "Done - unacked";
    if (job.kind === "failed")
        return "Failed - unacked";
    if (job.kind === "interrupted")
        return "Interrupted - unacked";
    return job.kind || "Unknown";
}

function fit(render, text, font, maxWidth, reserveMark) {
    let value = text || "";
    if (render.getTextWidth(value, font) <= maxWidth)
        return value;

    const suffix = reserveMark ? ".." : "...";
    while (value.length > 0 && render.getTextWidth(value + suffix, font) > maxWidth)
        value = value.slice(0, -1);
    return value + suffix;
}

function makePalette(render) {
    return {
        black: render.makeColor(0, 0, 0),
        white: render.makeColor(255, 255, 255),
        gray: render.makeColor(90, 90, 90),
        red: render.makeColor(180, 0, 0)
    };
}

export default {
    drawDashboard
};
