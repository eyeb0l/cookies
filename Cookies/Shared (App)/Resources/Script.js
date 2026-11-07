function show(platform, enabled, useSettingsInsteadOfPreferences) {
    document.body.classList.add(`platform-${platform}`);

    if (useSettingsInsteadOfPreferences) {
        document.querySelector(".platform-mac.state-on .mac-text").innerText = "Cookies is on. You can turn it off in the Extensions section of Safari Settings.";
        document.querySelector(".platform-mac.state-off .mac-text").innerText = "Cookies is off. Turn it on in the Extensions section of Safari Settings.";
        document.querySelector(".platform-mac.state-unknown .mac-text").innerText = "You can turn on Cookies in the Extensions section of Safari Settings.";
        document.querySelector("button.open-preferences").innerText = "Quit and Open Safari Settings…";
    }

    if (typeof enabled === "boolean") {
        document.body.classList.toggle("state-on", enabled);
        document.body.classList.toggle("state-off", !enabled);
    } else {
        document.body.classList.remove("state-on");
        document.body.classList.remove("state-off");
    }
}

// Called from ViewController.swift with
// { available: Bool, reason: String, message: String }.
function showModel(status) {
    const dot = document.getElementById("model-dot");
    const message = document.getElementById("model-message");
    if (!status || typeof status !== "object") {
        return;
    }

    let state = "off";
    if (status.available === true) {
        state = "on";
    } else if (status.reason === "model-not-ready") {
        state = "pending";
    }

    dot.className = `dot dot-${state}`;
    message.textContent = typeof status.message === "string" ? status.message : "";
    document.getElementById("model-status").dataset.reason = String(status.reason || "");
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

document.querySelector("button.open-preferences").addEventListener("click", openPreferences);
