"use strict";

// Only the service worker may persist or change Watchdog jobs.
const ALARM_NAME = "watchdog-lite";
const CHATGPT_ORIGIN = "https://chatgpt.com";
const MAX_JOBS = 20;
const MAX_TURNS = 100;
const ALLOWED_PATCH_FIELDS = {
  mode: (value) => ["ERROR", "PAUSED"].includes(value),
  phase: (value) => ["BOOT", "SENDING", "WAIT", "DONE"].includes(value),
  kind: (value) => ["", "BOOT", "CONTINUE", "REPAIR", "RESCUE"].includes(value),
  cmd: (value) =>
    typeof value === "string" &&
    (value === "" || /^cmd-[a-zA-Z0-9-]{8,80}$/.test(value)),
  turn: (value) => Number.isInteger(value) && value >= 0 && value <= MAX_TURNS,
  since: isTime,
  seen: isTime,
  recoveries: smallCounter,
  repairs: smallCounter,
  rescues: smallCounter,
  anchor: (value) => shortText(value, 128),
  ignoreError: (value) => typeof value === "boolean",
  detail: (value) => shortText(value, 500),
  result: (value) => ["", "PASS", "FAIL"].includes(value),
  error: (value) => shortText(value, 500),
  attention: (value) => shortText(value, 500),
};

function isTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function smallCounter(value) {
  return Number.isInteger(value) && value >= 0 && value <= 10;
}
function shortText(value, max) {
  return typeof value === "string" && value.length <= max;
}
function normalizedUrl(raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.origin !== CHATGPT_ORIGIN || parsed.username || parsed.password)
      return "";
    return parsed.origin + parsed.pathname.replace(/\/$/, "");
  } catch {
    return "";
  }
}
function target(raw) {
  const url = normalizedUrl(raw);
  if (!url) return null;

  const path = new URL(url).pathname.split("/").filter(Boolean);
  const chatId = /^[\w-]+$/;
  const gptId = /^g-[\w-]+$/;

  if (path.length === 2 && path[0] === "c" && chatId.test(path[1])) {
    return { url, tabOnly: false };
  }
  if (
    path.length === 4 &&
    path[0] === "g" &&
    gptId.test(path[1]) &&
    path[2] === "c" &&
    chatId.test(path[3])
  ) {
    return { url, tabOnly: false };
  }
  if (path.length === 2 && path[0] === "g" && gptId.test(path[1])) {
    return { url, tabOnly: true };
  }
  return null;
}
function isPopup(sender) {
  return (
    sender.id === chrome.runtime.id &&
    sender.url === chrome.runtime.getURL("popup.html")
  );
}
function isContent(sender) {
  return (
    sender.id === chrome.runtime.id &&
    Number.isInteger(sender.tab?.id) &&
    normalizedUrl(sender.url) !== ""
  );
}
function requirePopup(sender) {
  if (!isPopup(sender))
    throw new Error("This command is available only from the extension popup.");
}
function requireContent(sender) {
  if (!isContent(sender))
    throw new Error("This command is available only from a ChatGPT tab.");
}

let queue = Promise.resolve();
function serialize(operation) {
  const task = queue.then(operation, operation);
  queue = task.catch(() => {});
  return task;
}

async function loadJobs() {
  const { jobs } = await chrome.storage.local.get("jobs");
  return jobs && typeof jobs === "object" && !Array.isArray(jobs) ? jobs : {};
}
const saveJobs = (jobs) => chrome.storage.local.set({ jobs });

async function armAlarm() {
  const jobs = await loadJobs();
  const hasRunningJobs = Object.values(jobs).some(
    (job) => job?.mode === "RUNNING",
  );
  if (hasRunningJobs) {
    if (!(await chrome.alarms.get(ALARM_NAME))) {
      await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
    }
  } else {
    await chrome.alarms.clear(ALARM_NAME);
  }
}
chrome.runtime.onInstalled.addListener(() => {
  armAlarm().catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  armAlarm().catch(console.error);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.jobs) armAlarm().catch(console.error);
});
armAlarm().catch(console.error);

function validatePatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Invalid job patch.");
  }
  const entries = Object.entries(patch);
  if (entries.length === 0 || entries.length > 16)
    throw new Error("Invalid patch size.");
  for (const [field, value] of entries) {
    if (
      !Object.hasOwn(ALLOWED_PATCH_FIELDS, field) ||
      !ALLOWED_PATCH_FIELDS[field](value)
    ) {
      throw new Error("Rejected unsafe job patch.");
    }
  }
  return patch;
}

async function handle(message, sender) {
  if (!message || typeof message.type !== "string")
    throw new Error("Invalid message.");
  if (message.type === "IDENTIFY") {
    requireContent(sender);
    return { tabId: sender.tab.id };
  }
  if (message.type === "GET") {
    if (isPopup(sender)) return { jobs: await loadJobs() };
    requireContent(sender);
    const jobs = await loadJobs();
    return {
      jobs: Object.fromEntries(
        Object.entries(jobs).filter(
          ([, job]) => job?.mode === "RUNNING" && job.tabId === sender.tab.id,
        ),
      ),
    };
  }

  return serialize(async () => {
    const jobs = await loadJobs();

    if (message.type === "ADD") {
      requirePopup(sender);
      if (!Number.isInteger(message.tabId)) throw new Error("Invalid tab.");
      const tab = await chrome.tabs.get(message.tabId).catch(() => null);
      const selected = target(tab?.url);
      if (!tab || !selected || selected.url !== normalizedUrl(message.url)) {
        throw new Error("Откройте существующий диалог ChatGPT и повторите.");
      }
      if (
        Object.values(jobs).filter((job) => job?.mode === "RUNNING").length >=
        MAX_JOBS
      ) {
        throw new Error("Достигнут предел в 20 отслеживаемых диалогов.");
      }
      if (
        Object.values(jobs).some(
          (job) => job?.tabId === tab.id || job?.url === selected.url,
        )
      ) {
        throw new Error("Диалог уже в списке. Сначала удалите прежнюю запись.");
      }
      const id = crypto.randomUUID();
      jobs[id] = {
        id,
        runId: crypto.randomUUID(),
        tabId: tab.id,
        url: selected.url,
        tabOnly: selected.tabOnly,
        mode: "RUNNING",
        phase: "BOOT",
        cmd: "",
        kind: "",
        turn: 0,
        since: Date.now(),
        seen: Date.now(),
        recoveries: 0,
        repairs: 0,
        anchor: "",
        rescues: 0,
        ignoreError: false,
        detail: "Запуск: проверка страницы",
        result: "",
        error: "",
        attention: "",
        title: (tab.title || "Диалог ChatGPT").slice(0, 90),
      };
      await saveJobs(jobs);
      return { job: jobs[id] };
    }

    if (message.type === "STOP_ALL") {
      requirePopup(sender);
      await saveJobs({});
      return { ok: true };
    }

    if (message.type === "REMOVE") {
      requirePopup(sender);
      if (typeof message.id !== "string") throw new Error("Invalid job ID.");
      delete jobs[message.id];
      await saveJobs(jobs);
      return { ok: true };
    }

    requireContent(sender);
    const job = jobs[message.id];
    if (
      !job ||
      job.runId !== message.runId ||
      job.mode !== "RUNNING" ||
      job.tabId !== sender.tab.id
    )
      return { ok: false };

    const tab = await chrome.tabs.get(job.tabId).catch(() => null);
    if (message.type === "CHECK") {
      return {
        ok:
          job.cmd === message.cmd &&
          job.phase === "SENDING" &&
          normalizedUrl(tab?.url) === job.url,
      };
    }

    if (message.type === "UPGRADE") {
      const next = normalizedUrl(tab?.url);
      if (
        !job.tabOnly ||
        !job.anchor ||
        message.anchor !== job.anchor ||
        !next.startsWith(job.url + "/c/") ||
        !target(next) ||
        target(next).tabOnly
      ) {
        return { ok: false };
      }
      job.url = next;
      job.tabOnly = false;
      job.seen = Date.now();
    } else if (message.type === "PATCH") {
      if (
        normalizedUrl(tab?.url) !== job.url ||
        job.url !== message.expectedUrl ||
        job.phase !== message.expectedPhase
      )
        return { ok: false };
      const patch = validatePatch(message.patch);
      Object.assign(job, patch);
    } else {
      return { ok: false };
    }

    await saveJobs(jobs);
    return { ok: true, job };
  });
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  handle(message, sender)
    .then(reply)
    .catch((error) => reply({ error: String(error.message || error) }));
  return true;
});

chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name !== ALARM_NAME) return;
  serialize(async () => {
    const jobs = await loadJobs();
    let changed = false;

    for (const job of Object.values(jobs)) {
      if (job?.mode !== "RUNNING") continue;
      const tab = await chrome.tabs.get(job.tabId).catch(() => null);
      const current = normalizedUrl(tab?.url);

      if (
        job.tabOnly &&
        current !== job.url &&
        current.startsWith(job.url + "/c/") &&
        target(current)
      ) {
        // Content script must verify the GPT history fingerprint before UPGRADE.
        continue;
      }
      if (current !== job.url) {
        Object.assign(job, {
          mode: "ERROR",
          error:
            "Вкладка закрыта или переключена. Автоматическое открытие отключено.",
        });
        changed = true;
        continue;
      }
      if (Date.now() - (job.seen || 0) < 90_000) continue;

      const ping = await chrome.tabs
        .sendMessage(tab.id, { type: "PING" })
        .catch(() => null);
      if (ping?.ok) {
        job.seen = Date.now();
        job.recoveries = 0;
      } else {
        const injected = await chrome.scripting
          .executeScript({
            target: { tabId: tab.id },
            files: ["content.js"],
          })
          .then(() => true)
          .catch(() => false);
        job.recoveries = (job.recoveries || 0) + 1;
        if (!injected || job.recoveries >= 3) {
          Object.assign(job, {
            mode: "ERROR",
            error:
              "Скрипт недоступен. Перезагрузите страницу вручную и добавьте диалог снова.",
          });
        } else {
          job.seen = Date.now();
        }
      }
      changed = true;
    }

    if (changed) await saveJobs(jobs);
  }).catch(console.error);
});
