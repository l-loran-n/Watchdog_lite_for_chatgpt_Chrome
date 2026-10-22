(() => {
  if (globalThis.__watchdog637) return;
  globalThis.__watchdog637 = true;

  const LIMIT = {
    stable: 7000,
    send: 60000,
    history: 60000,
    page: 120000,
    answer: 120 * 60000,
    repair: 2,
    rescue: 2,
    rescueWait: 90000,
    maxTurns: 100,
  };
  const $ = (q) => document.querySelector(q);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const read = (n) => (n?.innerText || n?.textContent || "").trim();
  const url = () => location.origin + location.pathname.replace(/\/$/, "");
  const rpc = (m) => chrome.runtime.sendMessage(m);
  // ChatGPT иногда оставляет в DOM скрытый старый editor и текст подсказки.
  // Работать можно только с действительно видимым полем ввода.
  function visible(el) {
    if (
      !el?.isConnected ||
      el.closest('[hidden], [inert], [aria-hidden="true"]')
    )
      return false;
    const r = el.getBoundingClientRect(),
      css = getComputedStyle(el);
    return (
      r.width > 4 &&
      r.height > 4 &&
      css.display !== "none" &&
      css.visibility !== "hidden" &&
      css.opacity !== "0"
    );
  }
  const composer = () =>
    [
      ...document.querySelectorAll(
        '#prompt-textarea, textarea[name="prompt-textarea"], div.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"]',
      ),
    ]
      .filter(visible)
      .at(-1) || null;
  const clean = (text) =>
    (text || "")
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
      .replace(/\u00a0/g, " ")
      .trim();
  const sameText = (a, b) =>
    clean(a).replace(/\s+/g, "") === clean(b).replace(/\s+/g, "");
  function draftText(el) {
    if (!el) return "";
    if (el.matches("textarea, input")) return clean(el.value);
    // Только настоящие текстовые узлы. Плейсхолдеры, служебные и скрытые
    // дочерние узлы не являются пользовательским черновиком.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let text = "",
      node;
    while ((node = walker.nextNode())) {
      let hidden = false;
      for (let p = node.parentElement; p && p !== el; p = p.parentElement) {
        const placeholder = p.getAttribute("data-placeholder");
        if (
          p.matches(
            '[hidden], [aria-hidden="true"], [contenteditable="false"]',
          ) ||
          (placeholder && clean(p.textContent) === clean(placeholder)) ||
          (p.matches('[data-testid*="placeholder"]') &&
            !clean(p.textContent)) ||
          !visible(p)
        ) {
          hidden = true;
          break;
        }
      }
      if (!hidden) text += node.nodeValue;
    }
    return clean(text);
  }
  const generating = () =>
    !!$(
      '[data-is-streaming="true"], button[data-testid="stop-button"], button[data-testid="stop-generating-button"], button[aria-label*="Stop generating"], button[aria-label*="Stop streaming"], button[aria-label="Stop"], button[aria-label*="Остановить"]',
    );
  const sendButton = (editor) => {
    const selector =
      'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"], button[aria-label="Отправить"]';
    return (
      editor?.closest("form")?.querySelector(selector) ||
      [...document.querySelectorAll(selector)].filter(visible).at(-1) ||
      null
    );
  };

  // Считываем только основной контент диалога; меню, подсказки и черновик исключены.
  function turns() {
    const main = $("main") || $('[role="main"]');
    if (!main) return [];
    const selectors =
      '[data-testid^="conversation-turn-"], article[data-turn-id], [data-turn-id]';
    const containers = [...main.querySelectorAll(selectors)].filter(
      (n) => !n.parentElement?.closest(selectors),
    );
    const result = [];
    for (const el of containers) {
      const tagged = el.matches("[data-message-author-role]")
        ? el
        : el.querySelector(
            '[data-message-author-role="user"], [data-message-author-role="assistant"]',
          );
      const user = el.querySelector(
        '[data-testid="user-message"], .user-message-bubble-color',
      );
      const assistant = el.querySelector(
        '[data-testid="assistant-message"], .markdown, .prose',
      );
      const role =
        tagged?.getAttribute("data-message-author-role") ||
        (user ? "user" : assistant ? "assistant" : "");
      if (role !== "user" && role !== "assistant") continue;
      const body = tagged || (role === "user" ? user : assistant) || el;
      result.push({ role, text: read(body) || read(el), el });
    }
    // Не возвращаемся раньше времени: часть версий интерфейса смешивает форматы.
    const fallback =
      '[data-message-author-role="user"], [data-message-author-role="assistant"], [data-testid="user-message"], [data-testid="assistant-message"], .user-message-bubble-color, .markdown';
    for (const el of main.querySelectorAll(fallback)) {
      if (containers.some((root) => root.contains(el))) continue;
      if (el.parentElement?.closest(fallback)) continue;
      if (el.closest('form, [contenteditable="true"], nav, aside')) continue;
      const role =
        el.getAttribute("data-message-author-role") ||
        (el.matches('[data-testid="user-message"], .user-message-bubble-color')
          ? "user"
          : "assistant");
      result.push({ role, text: read(el), el });
    }
    result.sort((a, b) =>
      a.el === b.el
        ? 0
        : a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING
          ? -1
          : 1,
    );
    return result
      .map(({ role, text }) => ({ role, text }))
      .filter((t) => t.text);
  }

  function chatError() {
    const main = $("main") || $('[role="main"]');
    if (!main) return "";
    const pattern =
      /Время ожидания доставки сообщения истекло|message delivery timed out|There was an error generating|Something went wrong|Произошла ошибка при генерации/i;
    const retry = [...main.querySelectorAll("button")]
      .filter(visible)
      .find((b) =>
        /^(Повторить|Retry|Try again|Попробовать снова)$/i.test(read(b)),
      );
    if (retry) {
      let ancestor = retry;
      for (
        let i = 0;
        ancestor && i < 6;
        i++, ancestor = ancestor.parentElement
      ) {
        const t = read(ancestor);
        if (t.length < 1200 && pattern.test(t))
          return "ChatGPT не доставил ответ. Нажмите «Повторить» на странице. Watchdog не отправляет новых команд до восстановления.";
      }
    }
    const alert = [
      ...main.querySelectorAll('[role="alert"], [data-testid*="error"]'),
    ]
      .filter(visible)
      .map(read)
      .find((t) => t.length < 600 && pattern.test(t));
    return alert
      ? "ChatGPT сообщил техническую ошибку. Исправьте её в диалоге; Watchdog ожидает."
      : "";
  }

  function fingerprint() {
    const t = turns(),
      a = t.find((x) => x.role === "user"),
      b = t.find((x) => x.role === "assistant");
    if (!a?.text || !b?.text) return "";
    const raw = a.text + "\0" + b.text;
    let hash = 2166136261;
    for (let i = 0; i < raw.length; i++)
      hash = Math.imul(hash ^ raw.charCodeAt(i), 16777619);
    return raw.length + ":" + (hash >>> 0).toString(36);
  }
  // Строка статуса состоит из обычного текста: HTML-теги ChatGPT иногда скрывает.
  function status(answer, cmd) {
    const lines = [
      ...answer.matchAll(
        /(?:^|\n)\s*WD6_STATUS\s+COMMAND_ID=([\w-]+)\s+STATE=(WORKING|PASS|FAIL)\s*(?=\n|$)/g,
      ),
    ];
    if (
      lines.length === 1 &&
      lines[0][1] === cmd &&
      answer.trim().endsWith(lines[0][0].trim())
    )
      return lines[0][2];
    // Для уже запущенных диалогов поддерживается и старый протокол.
    const old = [
      ...answer.matchAll(
        /<WD_STATUS>\s*VERSION=1\s*COMMAND_ID=([\w-]+)\s*STATE=(WORKING|PASS|FAIL)\s*<\/WD_STATUS>/g,
      ),
    ];
    return old.length === 1 &&
      old[0][1] === cmd &&
      answer.trim().endsWith(old[0][0])
      ? old[0][2]
      : null;
  }
  function replyFor(cmd) {
    const t = turns();
    const i = t.findLastIndex(
      (x) =>
        x.role === "user" &&
        x.text.includes("[WATCHDOG LITE]") &&
        x.text.includes(`COMMAND_ID=${cmd}`),
    );
    if (i >= 0) {
      const after = t.slice(i + 1);
      if (after.some((x) => x.role === "user"))
        return { sent: true, conflict: true };
      const answer =
        after.filter((x) => x.role === "assistant").at(-1)?.text || "";
      // Если часть ответа скрыта или разбита на DOM-элементы, ниже проверим
      // также последний машинный статус по уникальному ID на самой странице.
      if (answer && status(answer, cmd)) return { sent: true, answer };
    }
    // Запасной вариант для Projects/GPT с неизвестной структурой DOM.
    // Принять можно только свежий уникальный COMMAND_ID, не слово PASS само по себе.
    const page = read($("main") || $('[role="main"]') || document.body);
    const marker = `COMMAND_ID=${cmd}`;
    const sent = page.includes("[WATCHDOG LITE]") && page.includes(marker);
    const lines = [
      ...page.matchAll(
        /(?:^|\n)\s*WD6_STATUS\s+COMMAND_ID=([\w-]+)\s+STATE=(WORKING|PASS|FAIL)\s*(?=\n|$)/g,
      ),
    ];
    const own = lines.filter((x) => x[1] === cmd);
    if (own.length === 1) return { sent: true, answer: own[0][0].trim() };
    if (i >= 0) {
      const after = t.slice(i + 1);
      return {
        sent: true,
        answer: after.filter((x) => x.role === "assistant").at(-1)?.text || "",
      };
    }
    return { sent, answer: "" };
  }
  function instruction(kind, cmd) {
    const purpose = {
      BOOT: "Продолжай исходное задание в этом диалоге. Если оно уже выполнено, сообщи PASS; если завершить его невозможно, сообщи FAIL; иначе WORKING. Не повторяй выполненных действий.",
      CONTINUE:
        "Продолжай исходное незавершённое задание без повторения выполненных действий.",
      REPAIR:
        "Не выполняй новую работу. Укажи только состояние результата предыдущего ответа.",
      RESCUE:
        "Предыдущий ответ ChatGPT завершился технической ошибкой. Продолжай исходную задачу с места остановки, не повторяя уже выполненные действия. Если задача полностью завершена — PASS, если выполнить её невозможно — FAIL, иначе — WORKING.",
    }[kind];
    return `${kind === "RESCUE" ? "продолжай, ты завис\n\n" : ""}[WATCHDOG LITE]\nMESSAGE_KIND=${kind}\nCOMMAND_ID=${cmd}\n\n${purpose}\n\nПоследней строкой ответа напиши строго: WD6_STATUS COMMAND_ID=${cmd} STATE=<одно значение>. Вместо <одно значение> используй только WORKING, PASS или FAIL (одно слово). Не используй HTML-теги или блок кода.`;
  }

  let tabId,
    busy = false,
    lastSample = "",
    stableSince = 0;
  chrome.runtime.onMessage.addListener((m, _sender, reply) => {
    if (m?.type === "PING") reply({ ok: true });
  });
  rpc({ type: "IDENTIFY" })
    .then((r) => {
      tabId = r?.tabId;
    })
    .catch(() => {});
  const all = async () => (await rpc({ type: "GET" })).jobs || {};
  const job = async () =>
    Object.values(await all()).find(
      (j) => j.mode === "RUNNING" && j.tabId === tabId,
    );
  async function patch(j, fields) {
    const r = await rpc({
      type: "PATCH",
      id: j.id,
      runId: j.runId,
      expectedUrl: j.url,
      expectedPhase: j.phase,
      patch: fields,
    });
    return r?.ok ? r.job : null;
  }
  const error = (j, reason) =>
    patch(j, { mode: "ERROR", error: reason, detail: "", attention: "" });
  const detail = (j, text) =>
    j.detail === text ? Promise.resolve(j) : patch(j, { detail: text });
  // Never reload automatically: reloading can discard a user's unsent draft.
  async function recover(j, reason) {
    return error(
      j,
      `Требуется вмешательство пользователя: ${reason}. Перезагрузка только вручную.`,
    );
  }
  function stable(key, value) {
    const text = key + "\n" + value;
    if (lastSample !== text) {
      lastSample = text;
      stableSince = Date.now();
    }
    return Date.now() - stableSince >= LIMIT.stable;
  }
  function fill(el, text) {
    el.focus();
    if (el.matches("textarea,input")) {
      const prototype = el.matches("textarea")
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      const selection = window.getSelection(),
        range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("insertText", false, text);
      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText" }),
      );
    }
  }
  async function send(j, kind) {
    // Bound automated messages; the user must explicitly start a new run.
    if (j.turn >= LIMIT.maxTurns)
      return error(
        j,
        "Предел 100 автоматических сообщений. Перезапуск только вручную.",
      );
    // RESCUE — новый технический запрос, а не повтор исходного задания.
    if (generating() || (chatError() && !j.ignoreError && kind !== "RESCUE"))
      return;
    if (kind === "RESCUE" && (j.rescues || 0) >= LIMIT.rescue)
      return error(j, "Две попытки вывести ChatGPT из зависания исчерпаны");
    const editor = composer();
    if (!editor) return recover(j, "Не найдено поле ввода");
    if (draftText(editor))
      return detail(
        j,
        "Ожидаю: в поле ввода есть пользовательский текст. Черновик не трогаю.",
      );
    const anchor = j.tabOnly ? fingerprint() : "";
    if (j.tabOnly && (!anchor || (j.anchor && j.anchor !== anchor)))
      return error(j, "Не удалось подтвердить историю GPT");
    const cmd = "cmd-" + crypto.randomUUID();
    const count = (j.rescues || 0) + (kind === "RESCUE" ? 1 : 0);
    const updated = await patch(j, {
      phase: "SENDING",
      kind,
      cmd,
      anchor: anchor || j.anchor,
      since: Date.now(),
      detail:
        kind === "RESCUE"
          ? `Восстановление ${count}/${LIMIT.rescue}: отправляю «продолжай, ты завис»`
          : "Подготовка отправки",
      turn: j.turn + 1,
      repairs: kind === "REPAIR" ? j.repairs + 1 : 0,
      recoveries: 0,
      rescues: count,
      ignoreError: kind === "RESCUE" || !!j.ignoreError,
      attention: "",
    });
    if (!updated) return;
    // Повторная проверка после записи намерения: пользователь мог начать печатать.
    if (draftText(editor)) {
      return patch(updated, {
        phase: j.phase,
        cmd: j.cmd,
        kind: j.kind,
        turn: j.turn,
        rescues: j.rescues,
        repairs: j.repairs,
        ignoreError: j.ignoreError,
        detail:
          "Ожидаю освобождения поля ввода; пользовательский текст не трогаю.",
      });
    }
    const payload = instruction(kind, cmd);
    fill(editor, payload);
    if (!sameText(draftText(editor), payload))
      return error(
        updated,
        "Редактор не подтвердил вставку команды. Отправка отменена.",
      );
    let button;
    for (let i = 0; i < 12; i++) {
      button = sendButton(editor);
      if (button && !button.disabled) break;
      await wait(200);
    }
    if (!button || button.disabled) {
      if (sameText(draftText(editor), payload)) fill(editor, "");
      return error(
        updated,
        "Кнопка отправки недоступна. Команда не отправлена.",
      );
    }
    const check = await rpc({ type: "CHECK", id: j.id, runId: j.runId, cmd });
    if (
      !check?.ok ||
      generating() ||
      (chatError() && !updated.ignoreError) ||
      url() !== updated.url ||
      !sameText(draftText(editor), payload)
    )
      return error(
        updated,
        "Обстановка перед отправкой изменилась; команда не отправлена",
      );
    button.click(); // После неоднозначного клика тот же COMMAND_ID не отправляется второй раз.
    await patch(updated, {
      phase: "WAIT",
      since: Date.now(),
      detail:
        kind === "RESCUE"
          ? `Спасательное сообщение ${count}/${LIMIT.rescue} отправлено; жду ответ`
          : "Команда отправлена; ожидаю ответ ChatGPT",
    });
  }

  async function tick() {
    if (busy || tabId == null) return;
    busy = true;
    try {
      let j = await job();
      if (!j) return;
      if (j.url !== url()) {
        if (
          j.tabOnly &&
          url().startsWith(j.url + "/c/") &&
          j.anchor &&
          fingerprint() === j.anchor
        )
          await rpc({
            type: "UPGRADE",
            id: j.id,
            runId: j.runId,
            anchor: j.anchor,
          });
        return;
      }
      if (j.tabOnly && j.anchor && fingerprint() !== j.anchor)
        return error(j, "Вкладка GPT показывает другую переписку");
      const now = Date.now();
      if (now - j.seen > 20_000) j = (await patch(j, { seen: now })) || j;
      const issue = chatError();
      // Ошибка предыдущего хода может продолжать висеть после успешного RESCUE.
      // Игнорируем её до исчезновения плашки, но ждём подтверждения каждого нового ответа.
      if (!issue && (j.ignoreError || j.rescues || j.attention))
        j =
          (await patch(j, { ignoreError: false, rescues: 0, attention: "" })) ||
          j;
      const unresolved = issue && !j.ignoreError;
      const age = now - j.since;

      if (j.phase === "BOOT") {
        if (!composer()) {
          await detail(j, "Ожидаю поле ввода ChatGPT");
          return (
            age > LIMIT.page && (await recover(j, "Страница не загрузилась"))
          );
        }
        if (generating()) {
          stable("GENERATING", "");
          await detail(j, "ChatGPT генерирует ответ; ожидание завершения");
          return (
            age > LIMIT.answer &&
            (await error(j, "Генерация не завершилась за 120 минут"))
          );
        }
        if (j.tabOnly && !fingerprint()) {
          await detail(j, "Проверяю историю GPT без ссылки /c/");
          return (
            age > LIMIT.history &&
            (await error(j, "Невозможно подтвердить диалог без /c/"))
          );
        }
        if (unresolved) {
          await detail(
            j,
            "ChatGPT завис при доставке сообщения; подготавливаю восстановление",
          );
          if (stable("ERROR", issue)) return send(j, "RESCUE");
          return;
        }
        await detail(j, "Диалог найден; проверяю, что генерация остановилась");
        const tail = read(
          $("main") || $('[role="main"]') || document.body,
        ).slice(-350);
        if (!stable("READY", url() + "\n" + tail)) return;
        return send(j, "BOOT");
      }
      if (j.phase === "SENDING") {
        if (replyFor(j.cmd).sent)
          return patch(j, { phase: "WAIT", since: now });
        // Если клик был сделан, но отправка неизвестна, не повторяем его без подтверждения.
        return (
          age > LIMIT.send &&
          (await error(j, "Отправка не подтверждена; автоповтор запрещён"))
        );
      }
      if (j.phase !== "WAIT") return error(j, "Неизвестное состояние");
      const reply = replyFor(j.cmd);
      if (reply.conflict)
        return error(
          j,
          "После команды Watchdog пользователь написал сообщение",
        );
      if (generating()) {
        await detail(j, "ChatGPT генерирует ответ; ожидание завершения");
        return (
          age > LIMIT.answer &&
          (await error(j, "Генерация не завершилась за 120 минут"))
        );
      }

      // Правильный статус важнее старой красной плашки ошибки.
      if (reply.answer && stable(j.cmd, reply.answer)) {
        const s = status(reply.answer, j.cmd);
        if (s === "PASS" || s === "FAIL")
          return patch(j, {
            mode: "PAUSED",
            phase: "DONE",
            detail: `Результат: ${s}`,
            result: s,
            error: "",
            attention: "",
          });
        if (s === "WORKING") return send(j, "CONTINUE");
        if (j.repairs < LIMIT.repair) return send(j, "REPAIR");
        return error(
          j,
          "После двух STATUS_REPAIR корректный статус не получен",
        );
      }

      if (unresolved) {
        await detail(
          j,
          "Ошибка доставки ChatGPT: пробую отправить «продолжай, ты завис»",
        );
        if (stable("ERROR", issue)) return send(j, "RESCUE");
        return;
      }
      // Если спасательное сообщение тоже не получило ответа, разрешена одна
      // дополнительная попытка только при наличии того же сбоя и по таймауту.
      if (
        issue &&
        j.ignoreError &&
        age >= LIMIT.rescueWait &&
        reply.sent &&
        !reply.answer
      ) {
        if ((j.rescues || 0) < LIMIT.rescue) return send(j, "RESCUE");
        return error(j, "ChatGPT не ответил после двух спасательных сообщений");
      }
      if (!reply.sent) {
        await detail(j, "Команда отправлена; ожидаю появления ответа");
        return (
          age > LIMIT.page &&
          (await error(j, "Отправка не подтверждена; повтор запрещён"))
        );
      }
      await detail(
        j,
        j.kind === "RESCUE"
          ? "Спасательное сообщение доставлено; ожидаю ответ"
          : "Ожидаю ответ или строку WD6_STATUS",
      );
      return (
        age > LIMIT.answer &&
        (await error(j, "Не удалось прочитать ответ; повтор запрещён"))
      );
    } catch (e) {
      const j = await job().catch(() => null);
      if (j && j.url === url())
        await error(j, String(e.message || e)).catch(() => {});
    } finally {
      busy = false;
    }
  }
  setInterval(tick, 1600);
  tick();
})();
