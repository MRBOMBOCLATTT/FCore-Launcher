const crypto = require("crypto");
const http = require("http");
const fetch = require("node-fetch");
const { offlineUuid, isValidOfflineName } = require("./offlineUuid");

const CLIENT_ID = "pfc-launcher2";
const REDIRECT_PORT = 48215;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

const DEVICE_URL = "https://account.ely.by/api/oauth2/v1/devicecode";
const TOKEN_URL = "https://account.ely.by/api/oauth2/v1/token";
const PROFILE_URL ="https://account.ely.by/api/mojang/services/minecraft/profile";

function loginOffline(username) {
    const name = String(username || "").trim();
    if (!isValidOfflineName(name)) {
        throw new Error("Ник должен состоять из 3–16 символов: латинские буквы, цифры и _");
    }
    const uuid = offlineUuid(name);

    return {
        mclcAuth: {
            access_token: "offline",
            client_token: "offline",
            uuid,
            name,
            user_properties: "{}"
        },

        profile: {
            uuid,
            name,
            type: "offline"
        }
    };
}

async function refreshToken(refreshToken) {

    const body = new URLSearchParams({

        client_id: CLIENT_ID,

        grant_type: "refresh_token",

        refresh_token: refreshToken

    });

    const response = await fetch(TOKEN_URL, {

        method: "POST",

        headers: {
            "Content-Type":
                "application/x-www-form-urlencoded",
            "Accept":
                "application/json"
        },

        body

    });

    const json = await response.json();

    if (!response.ok) {
        throw new Error(
            json.error_description ||
            json.error ||
            "Не удалось обновить токен."
        );
    }

    return json;

}

// оборачиваем сырые сетевые/протокольные ошибки Ely.by в понятные фразы —
// пользователю не нужно видеть "TypeError: fetch failed" или голый JSON
function friendlyNetworkError(err) {
    if (err instanceof Error && err.message === "__cancelled__") return err;
    if (err && (err.code === "ENOTFOUND" || err.code === "ECONNREFUSED" || /fetch failed|network/i.test(err.message || ""))) {
        return new Error("Нет соединения с Ely.by. Проверь интернет и попробуй ещё раз.");
    }
    return err;
}

async function requestDeviceCode() {

    const body = new URLSearchParams({
        client_id: CLIENT_ID,
        scope: "account_info offline_access minecraft_server_session"
    });

    let response;
    try {
        response = await fetch(DEVICE_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json"
            },
            body
        });
    } catch (err) {
        throw friendlyNetworkError(err);
    }

    if (!response.ok) {
        if (response.status >= 500) {
            throw new Error("Ely.by сейчас недоступен (ошибка на их стороне). Попробуй позже.");
        }
        let text = "";
        try { text = await response.text(); } catch {}
        throw new Error(text || `Ely.by отклонил запрос на вход (код ${response.status})`);
    }

    return await response.json();
}

async function pollDeviceCode(device, cancelToken) {

    while (true) {

        if (cancelToken && cancelToken.cancelled) {
            throw new Error("__cancelled__");
        }

        await new Promise(r =>
            setTimeout(r, device.interval * 1000)
        );

        if (cancelToken && cancelToken.cancelled) {
            throw new Error("__cancelled__");
        }

        const body = new URLSearchParams({

            client_id: CLIENT_ID,

            grant_type:
                "urn:ietf:params:oauth:grant-type:device_code",

            device_code: device.device_code

        });

        let response, json;
        try {
            response = await fetch(TOKEN_URL, {

                method: "POST",

                headers: {
                    "Content-Type":
                        "application/x-www-form-urlencoded",

                    "Accept":
                        "application/json"
                },

                body

            });
            json = await response.json();
        } catch (err) {
            // Разовый сетевой сбой (вылетел вайфай, ely.by моргнул) не должен
            // рвать весь вход — просто пробуем на следующем тике поллинга
            continue;
        }

        if (json.error === "authorization_pending")
            continue;

        if (json.error === "slow_down") {

            device.interval += 5;

            continue;

        }

        if (json.error === "expired_token") {
    throw new Error("Код авторизации истёк — начни вход заново.");
}

if (json.error === "access_denied") {
    throw new Error("Вход отменён на сайте Ely.by.");
}

if (json.error) {
    throw new Error(
        json.error_description ||
        json.error
    );
}

        return json;

    }

}

async function fetchProfile(accessToken) {

    let response, json;
    try {
        response = await fetch(PROFILE_URL, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Accept": "application/json",
                "Content-Type": "application/json"
            }
        });
        json = await response.json();
    } catch (err) {
        throw friendlyNetworkError(err);
    }

    if (!response.ok) {
        throw new Error(
            json.errorMessage ||
            json.error ||
            "Не удалось получить профиль Minecraft. У аккаунта Ely.by может не быть привязанного профиля."
        );
    }

    return json;
}

module.exports = {
    CLIENT_ID,
    loginOffline,
    requestDeviceCode,
    pollDeviceCode,
    fetchProfile,
    refreshToken
};