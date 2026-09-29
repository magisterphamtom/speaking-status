/**
 * Speaking Status — version réparée pour Foundry VTT v13 / v14
 * (d'après le module original de Xaukael)
 *
 * - Plus besoin de socketlib : socket natif de Foundry (module.json → "socket": true)
 * - Plus de jQuery : DOM natif
 * - Mesure du micro indépendante (Web Audio), avec repli sur game.audio
 *
 * 1.3.1
 * - Jeton trouvé même sans « personnage assigné » : repli sur les jetons dont
 *   le joueur est explicitement propriétaire
 * - Marqueur masqué si le jeton n'est pas visible (vision, niveaux de scène v14)
 * - Message clair quand le micro est bloqué (connexion http non sécurisée)
 * - Outil de diagnostic : game.modules.get("speaking-status").api.diagnostic()
 *
 * 1.3.2
 * - Bouton « Activer le micro » quand le micro n'est pas encore autorisé :
 *   la demande se fait après un clic (mieux acceptée par les navigateurs)
 * - Explications affichées si le micro est bloqué ou introuvable
 */

(() => {
  const MODULE_ID = "speaking-status";
  const SOCKET = `module.${MODULE_ID}`;
  const RELEASE_MS = 250; // délai avant de considérer que la personne a fini de parler (anti-clignotement)

  /** Utilisateurs en train de parler : userId → couleur */
  const speakingUsers = new Map();

  let monitor = null;      // { stream, ctx, timer } ou { foundry: true }
  let releaseTimer = null;
  let lastDb = -140;       // dernier niveau mesuré (pour le diagnostic)
  let micError = null;     // raison de l'échec d'accès au micro

  /* ------------------------------------------------------------ */
  /*  Styles                                                      */
  /* ------------------------------------------------------------ */

  function injectStyles() {
    if (document.getElementById("speaking-status-styles")) return;
    const style = document.createElement("style");
    style.id = "speaking-status-styles";
    style.textContent = `
      /* Liste des joueurs */
      li.speaking-status-on > span:first-child {
        outline: 4px solid var(--speaking-color, #3BA53B);
        outline-offset: 1px;
      }
      li.speaking-status-on .player-name {
        text-shadow: 0 0 6px var(--speaking-color, #3BA53B);
      }
      /* Barre d'actions de jetons (module tiers) */
      #token-action-bar li.speaking-status-on {
        outline: 3px solid var(--speaking-color, #3BA53B);
      }
      /* Marqueur autour du jeton */
      #hud .speaking-token-marker {
        position: absolute;
        pointer-events: none;
        box-sizing: border-box;
        box-shadow: 0 0 calc(var(--speaking-width) * 3) var(--speaking-color);
        outline: var(--speaking-width) solid var(--speaking-color);
        animation: speaking-status-pulse 1s ease-in-out infinite alternate;
      }
      @keyframes speaking-status-pulse {
        from { opacity: 0.65; }
        to   { opacity: 1; }
      }
      /* Réglages : vumètre */
      .speaking-status-meter {
        position: relative;
        width: 100%;
        height: 14px;
        margin: 4px 0;
        background: #555;
        border-radius: 3px;
        overflow: hidden;
      }
      .speaking-status-meter .speaking-level {
        height: 100%;
        width: 0;
        background: #ddd;
        transition: width 50ms linear;
      }
      .speaking-status-meter .speaking-mark {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 2px;
        background: #e33;
      }
      .speaking-status-range { width: 100%; }
      /* Bouton « Activer le micro » */
      #speaking-status-prompt {
        position: fixed;
        top: 12px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 10000;
        max-width: 520px;
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        background: rgba(20, 20, 24, 0.95);
        color: #f0f0f0;
        border: 2px solid #3BA53B;
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
        font-size: 14px;
        line-height: 1.35;
      }
      #speaking-status-prompt .ss-buttons { display: flex; gap: 6px; }
      #speaking-status-prompt .ss-enable { flex: 1; }
      #speaking-status-prompt .ss-close { flex: 0 0 36px; }
    `;
    document.head.append(style);
  }

  /* ------------------------------------------------------------ */
  /*  Affichage                                                   */
  /* ------------------------------------------------------------ */

  function getSetting(key) {
    try { return game.settings.get(MODULE_ID, key); } catch { return undefined; }
  }

  function userColor(user) {
    const c = user?.color;
    return (c?.css ?? c?.toString?.() ?? c) || "#3BA53B";
  }

  /**
   * Jetons à entourer pour cet utilisateur, sur la scène affichée :
   * 1. ceux de son personnage assigné (Configuration du joueur) ;
   * 2. sinon, ceux dont il est explicitement propriétaire (pas le MJ).
   */
  function tokensFor(user) {
    if (!canvas?.ready || !user) return [];
    let tokens = user.character?.getActiveTokens() ?? [];
    if (!tokens.length && !user.isGM) {
      const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
      tokens = (canvas.tokens?.placeables ?? [])
        .filter(t => t.actor?.ownership?.[user.id] === OWNER);
    }
    return tokens.filter(t => !t.isPreview);
  }

  function updatePlayerList() {
    const items = document.querySelectorAll(
      "#players [data-user-id], #player-list [data-user-id]"
    );
    for (const li of items) {
      const color = speakingUsers.get(li.dataset.userId);
      li.classList.toggle("speaking-status-on", !!color);
      if (color) li.style.setProperty("--speaking-color", color);
    }
  }

  function removeTokenMarkers(userId) {
    const sel = userId
      ? `.speaking-token-marker[data-user-id="${userId}"]`
      : ".speaking-token-marker";
    document.querySelectorAll(sel).forEach(el => el.remove());
    document.querySelectorAll("#token-action-bar li.speaking-status-on").forEach(li => {
      if (!userId || li.dataset.speakingUser === userId) li.classList.remove("speaking-status-on");
    });
  }

  function placeMarker(marker, token) {
    const grid = canvas.grid?.size ?? 100;
    const width = Math.max(2, grid / 20);
    const round = getSetting("round");
    Object.assign(marker.style, {
      left: `${token.x}px`,
      top: `${token.y}px`,
      width: `${token.w}px`,
      height: `${token.h}px`,
      borderRadius: round ? "50%" : `${width}px`,
      // Jeton caché, hors vision ou sur un autre niveau de scène : pas de marqueur
      display: token.visible === false ? "none" : ""
    });
    marker.style.setProperty("--speaking-width", `${width}px`);
  }

  function addTokenMarkers(user, color) {
    if (!getSetting("token")) return;
    const hud = document.getElementById("hud");
    if (!hud) console.warn(`${MODULE_ID} | élément #hud introuvable : marqueur de jeton impossible`);
    for (const t of tokensFor(user)) {
      if (hud && !hud.querySelector(`.speaking-token-marker[data-token-id="${t.id}"]`)) {
        const marker = document.createElement("div");
        marker.className = "speaking-token-marker";
        marker.dataset.tokenId = t.id;
        marker.dataset.userId = user.id;
        marker.style.setProperty("--speaking-color", color);
        placeMarker(marker, t);
        hud.append(marker);
      }
      const bar = document.querySelector(`#token-action-bar li[data-token-id="${t.id}"]`);
      if (bar) {
        bar.classList.add("speaking-status-on");
        bar.dataset.speakingUser = user.id;
        bar.style.setProperty("--speaking-color", color);
      }
    }
  }

  /** Appliqué sur chaque client (émetteur compris). */
  function applySpeaking(userId, speaking) {
    const user = game.users.get(userId);
    if (!user) return;
    const color = userColor(user);

    if (speaking) speakingUsers.set(user.id, color);
    else speakingUsers.delete(user.id);

    Hooks.callAll("changeSpeakingStatus", user, speaking);
    window.dispatchEvent(new CustomEvent("obs-speaking-update", {
      detail: { userId: user.id, speaking }
    }));

    updatePlayerList();
    removeTokenMarkers(user.id);
    if (speaking) addTokenMarkers(user, color);
  }

  /** Redessine tous les marqueurs (changement de scène, réglages…). */
  function redrawAll() {
    removeTokenMarkers();
    updatePlayerList();
    for (const [userId, color] of speakingUsers) {
      const user = game.users.get(userId);
      if (user) addTokenMarkers(user, color);
    }
  }

  /* ------------------------------------------------------------ */
  /*  Réseau                                                      */
  /* ------------------------------------------------------------ */

  function broadcast(speaking) {
    applySpeaking(game.user.id, speaking);          // le socket natif ne renvoie pas à l'émetteur
    game.socket.emit(SOCKET, { action: "speak", userId: game.user.id, speaking });
  }

  function setLocalSpeaking(speaking) {
    if (speaking) {
      clearTimeout(releaseTimer);
      releaseTimer = null;
      if (!game.user.speaking) {
        game.user.speaking = true;
        broadcast(true);
      }
    } else if (game.user.speaking && !releaseTimer) {
      releaseTimer = setTimeout(() => {
        releaseTimer = null;
        game.user.speaking = false;
        broadcast(false);
      }, RELEASE_MS);
    }
  }

  /* ------------------------------------------------------------ */
  /*  Micro                                                       */
  /* ------------------------------------------------------------ */

  function onLevel(db) {
    lastDb = db;
    const pct = Math.max(0, Math.min(100, ((db + 140) / 140) * 100));
    document.querySelectorAll(".speaking-status-meter .speaking-level")
      .forEach(el => { el.style.width = `${pct}%`; });
    setLocalSpeaking(db > game.user.speakingThreshold);
  }

  async function getMicStream() {
    const audioSrc = game.settings.get("core", "rtcClientSettings")?.audioSrc;
    const wanted = audioSrc && audioSrc !== "default"
      ? { audio: { deviceId: { ideal: audioSrc } }, video: false }
      : { audio: true, video: false };
    try {
      return await navigator.mediaDevices.getUserMedia(wanted);
    } catch (err) {
      if (wanted.audio === true) throw err;
      return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
  }

  /* ------------------------------------------------------------ */
  /*  Bouton « Activer le micro »                                 */
  /* ------------------------------------------------------------ */

  /**
   * Petit panneau affiché tant que le micro n'est pas actif.
   * La demande d'autorisation faite après un clic est mieux acceptée
   * par les navigateurs, et le clic débloque aussi l'audio.
   */
  function showMicPrompt(message) {
    let panel = document.getElementById("speaking-status-prompt");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "speaking-status-prompt";
      panel.innerHTML = `
        <div class="ss-text"></div>
        <div class="ss-buttons">
          <button type="button" class="ss-enable"><i class="fa-solid fa-microphone"></i> Activer le micro</button>
          <button type="button" class="ss-close" title="Fermer"><i class="fa-solid fa-xmark"></i></button>
        </div>`;
      panel.querySelector(".ss-enable").addEventListener("click", async ev => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        const ok = await startMicrophoneMonitor();
        btn.disabled = false;
        if (ok) ui.notifications?.info("Speaking Status : micro activé. Parle pour vérifier que ton nom s'allume.");
      });
      panel.querySelector(".ss-close").addEventListener("click", () => panel.remove());
      document.body.append(panel);
    }
    panel.querySelector(".ss-text").textContent = message;
  }

  function hideMicPrompt() {
    document.getElementById("speaking-status-prompt")?.remove();
  }

  const BLOCKED_HELP =
    "Micro bloqué par le navigateur. Clique sur l'icône à gauche de l'adresse (cadenas ou réglages), " +
    "passe « Microphone » sur « Autoriser », recharge la page (F5), puis clique sur « Activer le micro ».";

  /** Au chargement : démarre directement si le micro est déjà autorisé, sinon affiche le bouton. */
  async function autoStartOrAsk() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      return startMicrophoneMonitor(); // affiche le message http
    }
    let state = "prompt";
    try {
      state = (await navigator.permissions.query({ name: "microphone" })).state;
    } catch { /* navigateur sans cette API : on demandera par le bouton */ }

    if (state === "granted") {
      const ok = await startMicrophoneMonitor();
      if (!ok) showMicPrompt(`Speaking Status : le micro ne répond pas (${micError}).`);
    } else if (state === "denied") {
      micError = "autorisation du micro refusée dans le navigateur";
      showMicPrompt(`Speaking Status : ${BLOCKED_HELP}`);
    } else {
      showMicPrompt("Speaking Status : pour que ton jeton s'allume quand tu parles, active ton micro.");
    }
  }

  /* ------------------------------------------------------------ */

  let starting = null;

  /** Démarre la mesure du micro. Renvoie true si le micro est actif. */
  function startMicrophoneMonitor() {
    if (monitor) {
      monitor.ctx?.resume?.();
      hideMicPrompt();
      return Promise.resolve(true);
    }
    starting ??= _startMicrophoneMonitor().finally(() => { starting = null; });
    return starting;
  }

  async function _startMicrophoneMonitor() {
    // Le navigateur interdit le micro sur une page http non sécurisée
    // (ex. http://1.2.3.4:30000) : seuls https:// et localhost sont autorisés.
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      micError = "connexion non sécurisée (http) : le navigateur bloque le micro";
      console.warn(`${MODULE_ID} | ${micError}`);
      ui.notifications?.error(
        "Speaking Status : ton navigateur bloque le micro car Foundry est ouvert en http non sécurisé. " +
        "Il faut une adresse en https:// (ou localhost).",
        { permanent: true }
      );
      return false;
    }

    let stream;
    try {
      stream = await getMicStream();
    } catch (err) {
      micError = `${err?.name ?? "Erreur"} : ${err?.message ?? err}`;
      console.warn(`${MODULE_ID} | micro inaccessible`, err);
      const denied = err?.name === "NotAllowedError" || err?.name === "SecurityError";
      showMicPrompt(denied
        ? `Speaking Status : ${BLOCKED_HELP}`
        : "Speaking Status : aucun micro trouvé. Vérifie qu'il est branché et autorisé dans Windows " +
          "(Paramètres → Confidentialité → Microphone), puis réessaie.");
      return false;
    }
    micError = null;
    hideMicPrompt();

    // Mesure maison (Web Audio) — même échelle en dB que Foundry (≈ -140 à 0)
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.1;
      source.connect(analyser);
      const data = new Float32Array(analyser.frequencyBinCount);

      // Le navigateur peut suspendre l'audio avant le premier clic
      const resume = () => { if (ctx.state === "suspended") ctx.resume(); };
      resume();
      document.addEventListener("pointerdown", resume, { once: true });
      document.addEventListener("keydown", resume, { once: true });

      const timer = setInterval(() => {
        analyser.getFloatFrequencyData(data);
        let max = -Infinity;
        for (const v of data) if (v > max) max = v;
        onLevel(Number.isFinite(max) ? max : -140);
      }, 50);

      monitor = { stream, ctx, timer };
      return true;
    } catch (err) {
      console.warn(`${MODULE_ID} | Web Audio indisponible, repli sur game.audio`, err);
    }

    // Repli : l'outil intégré de Foundry
    if (game.audio?.startLevelReports) {
      game.audio.startLevelReports(MODULE_ID, stream, onLevel, 50);
      monitor = { stream, foundry: true };
      return true;
    }
    micError = "mesure du niveau audio impossible dans ce navigateur";
    stream.getTracks().forEach(t => t.stop());
    return false;
  }

  function stopMicrophoneMonitor() {
    if (!monitor) return;
    if (monitor.foundry) game.audio?.stopLevelReports?.(MODULE_ID);
    clearInterval(monitor.timer);
    monitor.ctx?.close();
    monitor.stream?.getTracks().forEach(t => t.stop());
    monitor = null;
    clearTimeout(releaseTimer);
    releaseTimer = null;
    game.user.speaking = false;
    broadcast(false);
  }

  function cleanSpeakingMarkers() {
    speakingUsers.clear();
    removeTokenMarkers();
    updatePlayerList();
  }

  /* ------------------------------------------------------------ */
  /*  Diagnostic                                                  */
  /* ------------------------------------------------------------ */

  /**
   * À lancer sur le poste du joueur concerné (macro ou console F12) :
   *   game.modules.get("speaking-status").api.diagnostic()
   */
  function diagnostic() {
    const u = game.user;
    const tokens = tokensFor(u);
    const info = {
      "Connexion sécurisée (https/localhost)": window.isSecureContext,
      "Micro accessible": !!monitor,
      "Erreur micro": micError ?? "aucune",
      "État audio": monitor?.ctx?.state ?? (monitor?.foundry ? "game.audio" : "—"),
      "Niveau actuel (dB)": Math.round(lastDb),
      "Seuil (dB)": u.speakingThreshold,
      "Personnage assigné": u.character?.name ?? "AUCUN",
      "Jetons trouvés sur la scène": tokens.map(t => t.name).join(", ") || "AUCUN",
      "Indicateur sur le jeton activé": !!getSetting("token")
    };
    console.table(info);
    if (!monitor && window.isSecureContext) showMicPrompt("Speaking Status : ton micro n'est pas actif.");

    const problems = [];
    if (!info["Connexion sécurisée (https/localhost)"]) problems.push("Foundry ouvert en http : micro bloqué");
    else if (!monitor) problems.push("micro non activé : clique sur « Activer le micro » en haut de l'écran");
    else if (monitor.ctx?.state === "suspended") problems.push("audio en pause : cliquer une fois dans Foundry");
    if (!tokens.length) problems.push("aucun jeton trouvé (assigner le personnage dans Configuration du joueur)");
    if (!info["Indicateur sur le jeton activé"]) problems.push("indicateur de jeton désactivé dans les réglages");

    const msg = problems.length
      ? `Speaking Status : ${problems.join(" · ")}`
      : `Speaking Status : tout est OK. Niveau ${info["Niveau actuel (dB)"]} dB, seuil ${info["Seuil (dB)"]} dB — parle et relance pour vérifier que le niveau dépasse le seuil.`;
    ui.notifications?.[problems.length ? "warn" : "info"](msg, { permanent: !!problems.length });
    return info;
  }

  // Compatibilité avec les macros qui appelaient les anciennes fonctions globales
  Object.assign(window, { startMicrophoneMonitor, stopMicrophoneMonitor, cleanSpeakingMarkers });

  /* ------------------------------------------------------------ */
  /*  Hooks                                                       */
  /* ------------------------------------------------------------ */

  Hooks.once("init", () => {
    injectStyles();

    game.settings.register(MODULE_ID, "threshold", {
      name: "Seuil de parole",
      hint: "En dB. Entre -50 et -60 convient généralement. Parle et regarde la barre : le trait rouge doit être juste sous ton niveau de voix.",
      scope: "client",
      config: true,
      type: Number,
      default: -55,
      onChange: value => { game.user.speakingThreshold = Number(value); }
    });

    game.settings.register(MODULE_ID, "token", {
      name: "Indicateur sur le jeton",
      hint: "Le jeton du personnage assigné au joueur (ou, à défaut, les jetons dont il est propriétaire) s'entoure de sa couleur quand il parle.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      onChange: () => redrawAll()
    });

    game.settings.register(MODULE_ID, "round", {
      name: "Indicateur rond",
      hint: "Bordure ronde autour du jeton au lieu d'un carré.",
      scope: "world",
      config: true,
      type: Boolean,
      default: false,
      onChange: () => redrawAll()
    });

    const mod = game.modules.get(MODULE_ID);
    if (mod) mod.api = { diagnostic, startMicrophoneMonitor, stopMicrophoneMonitor, cleanSpeakingMarkers };
  });

  Hooks.once("ready", () => {
    game.user.speaking = false;
    game.user.speakingThreshold = Number(getSetting("threshold") ?? -55);

    game.socket.on(SOCKET, data => {
      if (data?.action === "speak") applySpeaking(data.userId, !!data.speaking);
    });

    autoStartOrAsk();
  });

  // Un joueur qui se déconnecte ne doit pas rester « en train de parler »
  Hooks.on("userConnected", (user, connected) => {
    if (!connected && speakingUsers.has(user.id)) applySpeaking(user.id, false);
  });

  // Personnage assigné modifié en cours de partie
  Hooks.on("updateUser", (user, changes) => {
    if ("character" in changes && speakingUsers.has(user.id)) redrawAll();
  });

  // La liste des joueurs se redessine : réappliquer l'indicateur
  Hooks.on("renderPlayers", () => updatePlayerList());
  Hooks.on("renderPlayerList", () => updatePlayerList());

  // Changement de scène
  Hooks.on("canvasReady", () => redrawAll());

  // Suivre le jeton quand il bouge (et masquer le marqueur s'il n'est plus visible)
  Hooks.on("refreshToken", token => {
    if (token.isPreview) return;
    const marker = document.querySelector(`#hud .speaking-token-marker[data-token-id="${token.id}"]`);
    if (marker) placeMarker(marker, token);
  });

  // Réglages : vumètre + curseur sous le seuil
  Hooks.on("renderSettingsConfig", (app, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    const input = root?.querySelector(`[name="${MODULE_ID}.threshold"]`);
    if (!input || root.querySelector(".speaking-status-meter")) return;

    const meter = document.createElement("div");
    meter.className = "speaking-status-meter";
    meter.innerHTML = `<div class="speaking-level"></div><div class="speaking-mark"></div>`;
    const mark = meter.querySelector(".speaking-mark");

    const range = document.createElement("input");
    range.type = "range";
    range.min = "-120";
    range.max = "0";
    range.step = "1";
    range.className = "speaking-status-range";

    const sync = v => {
      range.value = v;
      mark.style.left = `${((Number(v) + 140) / 140) * 100}%`;
    };
    sync(input.value);

    range.addEventListener("input", () => {
      input.value = range.value;
      game.user.speakingThreshold = Number(range.value);
      sync(range.value);
    });
    input.addEventListener("input", () => {
      game.user.speakingThreshold = Number(input.value);
      sync(input.value);
    });

    const group = input.closest(".form-group") ?? input.parentElement;
    const hint = group.querySelector(".hint");
    const holder = document.createElement("div");
    holder.append(meter, range);
    if (hint) hint.before(holder);
    else group.append(holder);
  });
})();
