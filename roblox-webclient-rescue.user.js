// ==UserScript==
// @name         Roblox WebClient engine → archive.org rescue (places 7435428319 + 104612064449158)
// @namespace    rbx.wasm.archive.redirect
// @version      3.1.0
// @description  Serves the fetch()-loaded engine files (WebClient.wasm, WebClient.metadata.json, WebFlags.json) from web.archive.org snapshots, since the CDN copy 403s. NOTE: WasmPlayer.js / WebClient.js load via <script> tags and CANNOT be served from archive/blob by a userscript (page CSP) — serve those with Chrome DevTools Local Overrides instead. See header comment.
// @match        https://play.roblox.com/*
// @match        https://setup.rbxcdn.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      web.archive.org
// @connect      archive.org
// @license      MIT
// ==/UserScript==

/*
 * WHAT THIS DOES (v1.1.0)
 * The current engine version (version-f4a4dba57f874ad0) is dead on the Roblox
 * CDN (every file 403s), so the game can't boot. This script rescues the files
 * that the player loads via fetch()/XHR by downloading them in the privileged
 * userscript context (GM_xmlhttpRequest bypasses CORS + CSP) and serving them
 * to the page as same-origin `blob:` URLs (allowed by the page's connect-src):
 *   - WebClient.wasm            (101 MB, snapshot 20261028031147)
 *   - WebClient.metadata.json   (279 KB, snapshot 20261028022835, REQUIRED)
 *   - WebFlags.json             (156 B,  snapshot 20261028094936, optional)
 *
 * WHAT THIS CANNOT DO (page CSP limitation)
 * WasmPlayer.js and WebClient.js are loaded via <script src="..."> tags, and
 * the page's Content-Security-Policy script-src allows neither archive.org
 * nor blob:. No userscript can execute those from anywhere but an allowlisted
 * host. Serve them with Chrome DevTools Local Overrides instead:
 *   1. DevTools → Sources → Overrides → "Select folder for overrides" → Allow.
 *   2. Reload the page so the failed WasmPlayer.js request shows in Network.
 *   3. Right-click WasmPlayer.js → "Override content".
 *   4. In your overrides folder on disk, replace that file's contents with
 *      your rescued WasmPlayer.js (122,012 bytes), then reload (normal F5).
 *   5. Keep DevTools OPEN (undock it to its own window) while playing —
 *      overrides only apply while DevTools is attached to the tab.
 *   6. Do the same for WebClient.js ONLY if it also 403s — it may still load
 *      from your browser's HTTP cache (check the Network tab first).
 * IMPORTANT: use NORMAL reload (F5), never hard-refresh (Ctrl+Shift+R), and
 * keep DevTools' "Disable cache" checkbox OFF, or you'll evict good cache
 * entries for files that no longer exist anywhere else.
 *
 * v1.4 APP-SHELL EXPERIMENT: also activates on top-level /games/start with
 * NO placeId, to test whether the client shows any usable UI without joining.
 * (The game transport is dead, so joining is impossible; this only checks for
 * an offline-capable shell. Expect a stuck loading screen.)
 *
 * v1.3 WORKER BOOTSTRAP: Emscripten pthread workers spawn as
 * `new Worker(stub.js?src=<CDN WebClient.js>)`, and worker-context requests
 * bypass DevTools Local Overrides, so their importScripts() 403s. The script
 * therefore swaps those workers for blob: workers (allowed by worker-src)
 * whose source IS WebClient.js, fetched once through your working
 * WebClient.js override. Keep that override in place — the main thread AND
 * all workers depend on it.
 *
 * v1.5 FULL-LOCAL MODE (FULL_LOCAL_MODE = true, the default): performs NO
 * archive.org downloads and patches NO fetch/XHR/WebAssembly calls. Use it
 * when DevTools Local Overrides already serve the fetch()-loaded files from
 * disk (WebClient.wasm 101 MB, WebClient.metadata.json DECOMPRESSED 3.3 MB,
 * WebFlags.json) — same files as ever, but instant instead of re-downloaded
 * every page load. Only the Worker bootstrap stays active: it costs nothing
 * when overrides already cover workers, and saves the boot when they do not.
 * Set FULL_LOCAL_MODE = false to restore full archive.org rescue behavior
 * (useful if an override file goes missing — the script then becomes the
 * fallback source again).
 *
 * v1.8 C5a ORACLE (FORGED_PATCH_CONFIG): invalid JSON for InExperiencePatchConfig
 * file is dead on the CDN and was never archived, so the engine can never
 * fetch it. When FORGED_PATCH_CONFIG holds a JSON string, the script serves
 * those embedded bytes for the InExperiencePatchConfig.json URL (fetch AND
 * XHR — Emscripten uses XHR) INDEPENDENTLY of FULL_LOCAL_MODE: the three
 * engine files still come from disk overrides, only the patch config is
 * forged. Rung-1 candidates ship in the comments; the engine echoes our
 * JSON back (readOTAConfigs json={}) plus ACCEPTED/FILTERED verdicts, so
 * each attempt teaches us the schema. Null/empty = pure v1.5 behavior.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------- config ---
  const ENGINE_VERSION_DIR = 'version-f4a4dba57f874ad0-RobloxWebClient';
  const TARGET_PLACE_IDS = ['7435428319', '104612064449158'];
  // Snapshot timestamps verified 200 OK on web.archive.org (2026-10-28).
  const ARCHIVE_FILES = {
    'WebClient.wasm':          { snapshot: '20261028031147', type: 'application/wasm', kind: 'wasm', timeout: 600000 },
    'WebClient.metadata.json': { snapshot: '20261028022835', type: 'application/json', kind: 'json', timeout: 120000 },
    'WebFlags.json':           { snapshot: '20261028094936', type: 'application/json', kind: 'json', timeout: 120000 },
    // v1.6: served from the FORGED_PATCH_CONFIG constant below, never from archive.org.
    'InExperiencePatchConfig.json': { snapshot: null, type: 'application/json', kind: 'json', timeout: 10000, embedded: true },
    // v2.1: payload proxy (NOT embedded: fetched + gunzipped on demand)
    'InExperience.rbxm': { snapshot: null, type: 'application/octet-stream', kind: 'rbxm', timeout: 180000, proxy: 'https://assetdelivery.roblox.com/v1/asset/?id=80471914653504&version=15919', gunzip: true },
  };
  // v1.6 RUNG-1 CANDIDATE (edit + reload to iterate; null/'' disables forging):
  // C2 (embedded): genuine OTA-config shape copied from public desktop-client
  // logs: {"SchemaVersion":"1","CanaryUserIds":[],"CanaryPercentage":0}
  // v1.7 RUNG-2 (C4): Rung-1 proved the forged path works end-to-end, but the
  // engine ignored every C2 field (echoed assetId=0 etc.), so the real field
  // names differ. C4 carries BOTH camelCase (REAL values) and PascalCase
  // (distinguishable decoys) so the engine's echo reveals the true casing:
  //   assetId=80471914653504 -> camelCase wins | =11111111111111 -> Pascal wins
  //   assetVersion 16213 (true latest, bisected) vs 22222 decoy
  //   maxAppVersion 999999999 vs 888888888; localAssetURI InExperience vs DataModelPatch
// v2.8 (2026-10-29): SHADER SOLVED (v2.6 glsl3 pack worked; engine renders and
// ticks). Remaining fatal: post-TTI patch signature verification throws from
// an async worker fiber -> FatalRuntimeError ~26 s after load. v2.8 flips
// DFFlagEnableBackgroundSignatureVerification False->True so verification runs
// in the background instead of panicking the worker.
// v2.7 (2026-10-29): v2.6 hung instead of crashing -- deferral flip reverted.
// v2.6 SHADER (2026-10-29): rendering was a SEPARATE wall from the patch.
// SurfaceController only ever tries Mode 4 = shaders_glsles3_web.pack, the
// one shader pack in the manifest (there is no fallback pack listed), and it
// 403s. No archive snapshot exists. Desktop installs ship shaders_glsl3.pack
// instead (5a21: 4569049 B) -- the OpenGL sibling of the WebGL-ES3 pack.
// v2.6 serves that pack at the glsles3_web path via Local Overrides and
// moves the manifest size to 4569049 so the FS-JS gate accepts it. If the
// desktop-GL shader sources fail to compile under WebGL2 we will see shader
// compile errors instead of "Error opening shader pack" -- still progress.
// v2.5 PATCH-OPTIONAL (2026-10-29): v2.4 SIZE-REALIGN LOADED the genuine
// signed v15919 patch (14537511 B, manifest size matched, engine parsed it,
// joinGameSucceeded + gameLoaded both reached) but the deferred post-TTI
// check still reported "No signatures in the model could be verified" and
// then RBXCRASH'd FatalRuntimeError. The file genuinely contains a SIGU
// chunk (signatures over the uncompressed form, 324 B) AND a SIGN chunk
// (signatures over the compressed form, 324 B) -- it is Roblox-signed. So
// no amount of byte-juggling on our side can help; the verifier in this
// harness simply cannot validate it. v2.5 stops attacking the bytes and
// flips the two patch flags so a failed patch is treated as ABSENT.
// v2.4 SIZE-REALIGN (2026-10-29): v2.3 FORGE verdict = internal signature.
// Served 15673+346B zeros, config md5 matched, size gate passed, engine
// parsed and loaded gameLoaded -> then FLog::DataModelPatchConfigurer
// 'No signatures in the model could be verified' -> FatalRuntimeError.
// So: only GENUINE Roblox-signed bytes pass. v2.4 stops forging entirely:
// serve real v15919 (14537511 B, md5 df3b..., the exact patch the genuine
// 5a21 desktop config names) + the genuine 252 B config verbatim, and move
// the ONLY free variable into the manifest override (InExperience.rbxm
// size 14329926 -> 14537511) so the FS-JS gate accepts what the CDN-era
// manifest demanded. Inconsistency resolved on our side, not the engine's.
// v2.1 RBXM-PROXY: InExperience.rbxm payload proxied live from assetdelivery
// (v15673 donor + 346B zero-pad; config hash matched), gunzipped in-flight, served for the
// dead ExtraContent CDN URL. The v2.0 run proved the config parses (real echo)
// and the engine then GETs .../ExtraContent/models/InExperience/InExperience.rbxm.
// v2.0 RUNG-4: genuine desktop config served verbatim (see const below).
// v1.9 FLAG-FLIP: rewrite live WebClientApp settings in-flight
// (DFFlagReThrowGetCachedPatchException True->False: swallow the
// getCachedPatch throw instead of crashing). C5a oracle const KEPT,
// so one run yields BOTH signals (echo lines = oracle, crash-vs-
// progress = flag). Set ENABLE_FLAG_FLIP=false to re-run pure v1.8.
// v1.8 C5a ORACLE: deliberately INVALID JSON. Decides binary-vs-gradient:
// if the echo stays type=2/all-zeros (identical to C2/C4), then zeros are
// parse-failure defaults and the echo is BINARY (success vs zeros) — blind
// field probing. If echo/crash CHANGES, the parser distinguishes inputs.
// v2.0 GENUINE: byte-verbatim desktop InExperiencePatchConfig.json (252B,
// from version-5a21b87bbc2641cf, 2026-10-28). Real schema is PascalCase
// with STRING values + AppStorageResetId/IsForcedUpdate/LocalAssetHash --
// explains every prior zero (C2/C4 wrong case+types, C1 empty, C5a invalid).
const FORGED_PATCH_CONFIG = '{\"AppStorageResetId\": \"0\", \"AssetId\": \"80471914653504\", \"AssetVersion\": \"15919\", \"IsForcedUpdate\": false, \"LocalAssetURI\": \"rbxasset://models/InExperience/InExperience.rbxm\", \"LocalAssetHash\": \"df3b8680647869f80269d0e7a7d89d19\", \"MaxAppVersion\": \"099\"}';
  // C2 (rung-1, all fields ignored): const FORGED_PATCH_CONFIG = '{"SchemaVersion":"1","CanaryUserIds":[],"CanaryPercentage":0}';
  // C1 (minimal): const FORGED_PATCH_CONFIG = '{}';
  // --- v1.9 flag-flip machinery ---
  // v3.1 MAXAPP-GATE (2026-10-29): the client IS app version 745 and the config
// said MaxAppVersion "745", so the patch is REQUIRED and must verify. If the
// config instead targets an older app, the engine should treat the patch as
// not applicable and skip loading it entirely -- no verify, no crash. The
// value keeps 3 characters ("099") so the served config stays exactly 252 B
// and the manifest size gate is unaffected.
// v3.0 (2026-10-29): NOT retired after all -- but this time the flag NAMES came
// out of the wasm string table instead of being guessed, and the crash is now
// pinned to the OTA-patch verification path. See SETTINGS_FLAG_FLIPS below.
// v2.9: flag flipping looked RETIRED. Evidence: 'DFFlagEnableBackgroundSignatureVerification'
  // came back undefined in the live settings object (we were injecting a key that
  // does not exist), the ReThrow flip fired but the throw never passes through
  // getCachedPatch, and none of these flag names appear in the wasm at all
  // (the engine hashes setting names). Two flag runs produced byte-identical
  // crashes. The real fix now lives in the WebClient.js override (fibre-level
  // swallow), so leave settings completely untouched.
  const ENABLE_FLAG_FLIP = true;
  const SETTINGS_URL_MARK = 'clientsettingscdn.roblox.com/v2/settings/application/';
  // v2.5 PATCH-OPTIONAL: v2.4 proved the rbxm IS genuine + signed (SIGU/SIGN
  // chunks present, md5 df3b... matches the desktop-shipped file) yet the
  // post-TTI check still says "No signatures in the model could be verified".
  // So the failure is not our bytes -- it is the verification path itself,
  // and forging every legitimate avenue is exhausted. New angle: make the
  // InExperience patch OPTIONAL instead of trying to satisfy its verifier.
  //   FFlagDeferRbxmSignatureCheckToPostTti False -> run the check inline,
  //     inside getCachedPatch, where the ReThrow guard actually applies.
  //   DFFlagReThrowGetCachedPatchException False -> getCachedPatch returns
  //     empty instead of propagating the throw, so the engine proceeds
  //     WITHOUT the patch rather than aborting the worker.
  // v2.7 REVERT: v2.6's second flip (deferral True->False) moved the check
  // inline and REGRESSED crash -> HANG. With deferral off the verification
  // path waits on network material from the dead CDN:
  //   DFIntDeferredRbxmDownloadFetchTimeoutMs = 199930 ms, retried
  //   DFIntDataModelPatcherLoadRetry = 3
  // => minutes of silence with engine logs at zero. Reverted. Only the
  // ReThrow flip stays, so the throw is still meant to be swallowed in
  // getCachedPatch but the check itself still runs post-TTI (fast fail).
  // v2.8 BACKGROUND-VERIFY: v2.7 proved the throw does NOT pass through
  // getCachedPatch's ReThrow guard -- the crash stack is
  // $fiber_entry -> handleAsync -> RBX Worker E, i.e. an unhandled error
  // inside an async engine fiber (that = FatalRuntimeError/panic). So the
  // guard is on the wrong path. Live settings expose a flag that moves
  // verification itself off the critical path:
  //   DFFlagEnableBackgroundSignatureVerification = False -> True
  // ReThrow stays False (harmless, other call path).
  // v3.0 VERIFICATION-BYPASS: the wasm STRING TABLE names the switches directly
  // (they appear as bare names because the prefix is applied by the flag system):
  //     DebugSkipOtaPatchVerification        <- the patch we serve IS an OTA patch
  //     DebugSkipPostTtiSignatureVerification
  //     DebugSkipInAppOtaDownload / DebugBypassTeamTestSignatureVerification
  // and the engine even documents the outcome:
  //     "[FLog::DataModelPatcher] Post-TTI: signature verification SKIPPED
  //      (DebugSkipPostTtiSignatureVerification=true)"
  // The component that kills us -- DataModelPatchConfigurer, logging "No
  // signatures in the model could be verified" -- is the OTA patch verification
  // path. Neither debug flag exists in the live settings, so their compiled
  // defaults apply; we inject both casings and both prefixes (extra keys are
  // ignored, so this is a shotgun that cannot misfire).
  const SETTINGS_FLAG_FLIPS = {
    'FFlagDebugSkipOtaPatchVerification': 'True',
    'DFFlagDebugSkipOtaPatchVerification': 'True',
    'FFlagDebugSkipPostTtiSignatureVerification': 'True',
    'DFFlagDebugSkipPostTtiSignatureVerification': 'True',
  };
  function rewriteSettingsText(text, via) {
    try {
      const j = JSON.parse(text);
      const app = j && j.applicationSettings;
      if (app) {
        Object.keys(SETTINGS_FLAG_FLIPS).forEach((k) => {
          const before = app[k];
          app[k] = SETTINGS_FLAG_FLIPS[k];
          log('FLAG-FLIP (' + via + '): ' + k + ' ' + JSON.stringify(before) + ' -> ' + JSON.stringify(app[k]));
        });
        return JSON.stringify(j);
      }
    } catch (e) { /* fall through to regex */ }
    let out = text;
    Object.keys(SETTINGS_FLAG_FLIPS).forEach((k) => {
      const re = new RegExp('("' + k + '"\\s*:\\s*")[^,}]*');
      if (re.test(out)) { out = out.replace(re, '$1' + JSON.stringify(SETTINGS_FLAG_FLIPS[k])); log('FLAG-FLIP-regex (' + via + '): ' + k); }
    });
    return out;
  }
  function trapSettingsXHR(xhr) {
    if (xhr.__rbxSettingsTrapped) return;
    xhr.__rbxSettingsTrapped = true;
    // attached during open(), so this listener runs BEFORE the engine's own
    // handlers and the engine only ever sees rewritten text.
    xhr.addEventListener('readystatechange', () => {
      try {
        if (xhr.readyState !== 4 || xhr.__rbxSettingsDone) return;
        xhr.__rbxSettingsDone = true;
        const proto = uw.XMLHttpRequest.prototype;
        const dT = Object.getOwnPropertyDescriptor(proto, 'responseText');
        const origT = dT && dT.get ? dT.get.call(xhr) : null;
        if (typeof origT === 'string' && origT) {
          const mod = rewriteSettingsText(origT, 'xhr');
          Object.defineProperty(xhr, 'responseText', { value: mod, configurable: true });
          try {
            const dR = Object.getOwnPropertyDescriptor(proto, 'response');
            if (dR && dR.get && typeof dR.get.call(xhr) === 'string') {
              Object.defineProperty(xhr, 'response', { value: mod, configurable: true });
            }
          } catch (e2) { /* responseType-locked; ignore */ }
        }
      } catch (e) { warn('settings XHR trap error:', e); }
    });
    log('settings XHR trap armed (flag flip).');
  }
  // C3 (rung-2 sketch, GUESS — do not test yet):
  // const FORGED_PATCH_CONFIG = '{"SchemaVersion":"1","Patches":[{"assetId":80471914653504,"assetVersion":0,"maxAppVersion":999999,"engineVersion":"f4a4dba57f874ad0","isDev":false,"localAssetURI":"rbxasset://models/InExperience/InExperience.rbxm"}]}';
  const ALLOW_UNKNOWN_FRAMES = true;
  // v1.5: true = trust Local Overrides for wasm/metadata/flags (fast, local);
  // only the Worker bootstrap patch stays active. False = full archive.org
  // rescue of the fetch()-loaded files (slow re-download each load).
  const FULL_LOCAL_MODE = true;
  const TAG = '[rbx-wasm-archive]';

  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  function archiveUrlFor(file) {
    const snap = ARCHIVE_FILES[file].snapshot;
    return 'https://web.archive.org/web/' + snap + 'id_/https://setup.rbxcdn.com/webclient/' + ENGINE_VERSION_DIR + '/' + file;
  }

  // True if this matched file should actually be served (in FULL_LOCAL_MODE
  // only embedded/forged entries are served; disk overrides handle the rest).
  function shouldServe(file) {
    if (!file || !ARCHIVE_FILES[file]) return false;
    return !FULL_LOCAL_MODE || ARCHIVE_FILES[file].embedded === true || !!ARCHIVE_FILES[file].proxy;
  }

  // Returns the archived filename if this URL is one of our rescued files.
  function matchArchivedFile(u) {
    if (typeof u !== 'string') return null;
    if (u.indexOf(ENGINE_VERSION_DIR) === -1) return null;
    const names = Object.keys(ARCHIVE_FILES);
    for (let i = 0; i < names.length; i++) {
      const f = names[i];
      if (u.indexOf('/' + f) !== -1 || u.indexOf(f + '?') !== -1) return f;
    }
    return null;
  }

  // ------------------------------------------------- activation check ---
  function activationState() {
    const re = new RegExp('[?&]placeId=(' + TARGET_PLACE_IDS.join('|') + ')(?:[&#]|$)');
    try {
      if (re.test(location.href)) return { active: true, where: 'self URL' };
    } catch (e) { /* ignore */ }
    try {
      if (window.top && window.top !== window && re.test(window.top.location.href)) {
        return { active: true, where: 'top frame URL' };
      }
    } catch (e) { /* cross-origin top frame: unreadable */ }
    // Experimental app-shell mode: top-level /games/start with NO placeId at all.
    try {
      const isTop = window.self === window.top;
      if (isTop && location.hostname === 'play.roblox.com' &&
          location.pathname.indexOf('/games/start') !== -1 &&
          location.href.indexOf('placeId=') === -1) {
        return { active: true, where: 'start page without placeId (experimental)' };
      }
    } catch (e) { /* ignore */ }
    try {
      if (typeof document !== 'undefined' && document.referrer && re.test(document.referrer)) {
        return { active: true, where: 'referrer' };
      }
    } catch (e) { /* ignore */ }
    let inFrame = false;
    try { inFrame = window.self !== window.top; } catch (e) { inFrame = true; }
    if (inFrame && ALLOW_UNKNOWN_FRAMES) {
      return { active: true, where: 'unknown cross-origin frame (allowed by config)' };
    }
    return { active: false, where: 'no match' };
  }

  const state = activationState();
  if (!state.active) {
    log('not a target placeId (' + TARGET_PLACE_IDS.join(', ') + '); staying idle.');
    return;
  }

  const uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : null;
  if (!uw) {
    warn('unsafeWindow is unavailable; cannot patch page network calls. Aborting.');
    return;
  }
  if (!FULL_LOCAL_MODE && typeof GM_xmlhttpRequest === 'undefined') {
    warn('GM_xmlhttpRequest is unavailable. Use Tampermonkey or Violentmonkey. Aborting.');
    return;
  }

  if (FULL_LOCAL_MODE) {
    log('active (' + state.where + '). FULL-LOCAL MODE: fetch/XHR/wasm patches OFF (overrides serve from disk); Worker bootstrap ON.');
  } else {
    log('active (' + state.where + '). Rescuing engine files from archive.org snapshots.');
  }
  if (FORGED_PATCH_CONFIG) {
    log('CRAFTED v3.0 VERIFICATION-BYPASS config ACTIVE (genuine v15919 + debug skip-verify flags): serving ' + FORGED_PATCH_CONFIG.length + ' embedded chars for InExperiencePatchConfig.json.');
  }
  // v2.9: the actual fix is the patched WebClient.js override. Its hook sets
  // window.__rbxNoSigHook the moment that file evaluates, so we can PROVE the
  // override loaded instead of guessing (a stale/stock WebClient.js was the
  // failure mode last run).
  (function watchWebClientPatch() {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var on = false;
      try { on = !!(uw.__rbxNoSigHook || window.__rbxNoSigHook); } catch (e) { }
      if (on) {
        clearInterval(timer);
        log('v2.9 override CONFIRMED: patched WebClient.js is live (__rbxNoSigHook set).');
        return;
      }
      if (tries >= 40) {
        clearInterval(timer);
        warn('v2.9 override NOT DETECTED after 20s — the overrides folder is serving the STOCK WebClient.js (258675 / 9D2D09B9…). Check DevTools > Sources > Overrides is enabled and WebClient.js is 260388 / 8FF16EAE…');
      }
    }, 500);
  })();

  // -------------------------------------------- privileged download ---
  const blobPromises = new Map(); // file -> Promise<Blob>
  const blobUrls = new Map();     // file -> blob: URL string

  function validateBytes(file, buf) {
    const kind = ARCHIVE_FILES[file].kind;
    const v = new Uint8Array(buf);
    if (kind === 'wasm') {
      // Real .wasm starts with magic bytes 00 61 73 6D ("\0asm").
      if (buf.byteLength < 1024 || v[0] !== 0x00 || v[1] !== 0x61 || v[2] !== 0x73 || v[3] !== 0x6d) {
        throw new Error('not a wasm binary (' + buf.byteLength + ' bytes, bad magic)');
      }
    } else if (kind === 'json') {
      if (buf.byteLength < 2) throw new Error('empty file');
      const head = new TextDecoder().decode(v.subarray(0, 64)).trim();
      if (head[0] !== '{' && head[0] !== '[') {
        throw new Error('not JSON (starts with: ' + head.slice(0, 40) + ')');
      }
    }
  }

  function gmFetchFile(file) {
    return new Promise((resolve, reject) => {
      const spec = ARCHIVE_FILES[file];
      if (spec.proxy) {
        log('RBXM-PROXY: fetching ' + file + ' from assetdelivery…');
        uw.fetch(spec.proxy).then((resp) => {
          if (!resp.ok) throw new Error('proxy fetch HTTP ' + resp.status);
          return resp.arrayBuffer();
        }).then((buf) => {
          const b = new Uint8Array(buf);
          const magic = (b.length > 3) ? (b[0].toString(16) + b[1].toString(16) + b[2].toString(16) + b[3].toString(16)) : 'short';
          log('RBXM-PROXY: got ' + b.length + ' fetched bytes, magic=' + magic + '.');
          if (spec.gunzip && b.length > 2 && b[0] === 0x1f && b[1] === 0x8b) {
            log('RBXM-PROXY: gzip magic — gunzipping…');
            const ds = new uw.DecompressionStream('gzip');
            return new uw.Response(new uw.Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
          }
          log('RBXM-PROXY: raw bytes already (browser auto-decoded) — serving as-is.');
          return buf;
        }).then((raw) => {
          // v2.4 SIZE-REALIGN: serve GENUINE signed bytes untouched. No pad, no
          // slice, no forging. The manifest override must declare this exact
          // size (14537511) or the FS-JS gate discards the buffer (v2.1.1/v2.3).
          if (raw.byteLength !== 14537511) {
            log('SIZE-REALIGN (v2.4): WARNING expected 14537511 got ' + raw.byteLength + ' — manifest override and served bytes DISAGREE; the FS-JS gate will discard this.');
          } else {
            log('SIZE-REALIGN (v2.4): 14537511 bytes, byte-identical to the genuine signed v15919 patch — manifest override matches, signature untouched.');
          }
          log('RBXM-PROXY: serving ' + raw.byteLength + ' bytes for ' + file + '.');
          resolve(new uw.Blob([raw], { type: spec.type || 'application/octet-stream' }));
        }).catch((e) => {
          log('RBXM-PROXY: FAILED ' + (e && e.message ? e.message : e) + ' — rejecting (engine will throw the known CreatorError).');
          reject(e);
        });
        return;
      }
      if (spec.embedded) {
        try {
          // v1.7: FS-JS warns (non-fatally) unless the size matches the
          // manifest (252 for this config). Pad short configs with trailing
          // spaces (valid JSON whitespace); serve long ones as-is.
          let txt = FORGED_PATCH_CONFIG || '';
          if (txt.length < 252) txt = txt + new Array(252 - txt.length + 1).join(' ');
          const bytes = new TextEncoder().encode(txt);
          validateBytes(file, bytes.buffer);
          log('serving FORGED embedded bytes for ' + file + ' (' + bytes.length + ' chars' + (bytes.length === 252 ? ', manifest-size exact' : '') + ').');
          resolve(new Blob([bytes], { type: spec.type }));
        } catch (e) { reject(e); }
        return;
      }
      const verbose = spec.kind === 'wasm';
      if (verbose) log('downloading archived ' + file + ' (~101 MB, this can take a while)…');
      else log('downloading archived ' + file + '…');
      let lastMark = -1;
      GM_xmlhttpRequest({
        method: 'GET',
        url: archiveUrlFor(file),
        responseType: 'arraybuffer',
        timeout: spec.timeout,
        onprogress(ev) {
          if (!verbose) return;
          try {
            if (ev && ev.lengthComputable && ev.total > 0) {
              const pct = Math.floor((ev.loaded / ev.total) * 100);
              if (pct >= lastMark + 10) {
                lastMark = pct;
                log('download ' + pct + '% (' + (ev.loaded / 1048576).toFixed(1) + ' MB)');
              }
            } else if (ev && ev.loaded) {
              const mb = Math.floor(ev.loaded / 1048576);
              if (mb !== lastMark) { lastMark = mb; log('downloaded ' + mb + ' MB…'); }
            }
          } catch (e) { /* progress is best-effort */ }
        },
        onload(res) {
          try {
            if (!res || res.status < 200 || res.status >= 300) {
              reject(new Error('archive.org HTTP ' + (res && res.status) + ' for ' + file));
              return;
            }
            const buf = res.response;
            if (!(buf instanceof ArrayBuffer)) {
              reject(new Error('unexpected GM response type for ' + file));
              return;
            }
            validateBytes(file, buf);
            log(file + ' ready: ' + (buf.byteLength / 1024).toFixed(1) + ' KB, validation OK.');
            resolve(new Blob([buf], { type: spec.type }));
          } catch (e) {
            reject(e);
          }
        },
        onerror(err) { reject(new Error('network error for ' + file + ': ' + ((err && err.error) || 'unknown'))); },
        ontimeout() { reject(new Error('download of ' + file + ' timed out')); },
        onabort() { reject(new Error('download of ' + file + ' aborted')); }
      });
    });
  }

  function getFileBlob(file) {
    if (!blobPromises.has(file)) {
      blobPromises.set(file, gmFetchFile(file).catch((err) => {
        blobPromises.delete(file); // allow a later retry
        throw err;
      }));
    }
    return blobPromises.get(file);
  }

  function getFileBlobUrl(file) {
    return getFileBlob(file).then((blob) => {
      if (blobUrls.has(file)) return blobUrls.get(file);
      let url;
      try {
        url = URL.createObjectURL(blob);
      } catch (e) {
        url = uw.URL.createObjectURL(blob); // fallback: page-context registration
      }
      blobUrls.set(file, url);
      log('blob URL ready for ' + file);
      return url;
    });
  }

  // Prefetch everything up front so bytes are ready before the page asks.
  // (skipped entirely in FULL-LOCAL MODE — overrides serve from disk.)
  Object.keys(ARCHIVE_FILES).forEach((f) => {
    if (FULL_LOCAL_MODE && !ARCHIVE_FILES[f].embedded) return; // disk overrides serve these
    getFileBlob(f).catch((err) => warn('prefetch failed for ' + f + ' (will retry on demand):', err));
  });

  // --------------------------------------------- patch page network ---
  // Page globals are patched via unsafeWindow (no <script> injection, so the
  // page's strict script-src CSP is not an issue). Proxies keep
  // `fn.toString()` / `instanceof` checks looking native.

  // --- fetch --- (in FULL-LOCAL MODE only embedded/forged entries are served)
  if (!FULL_LOCAL_MODE || FORGED_PATCH_CONFIG) try {
    const origFetch = uw.fetch;
    uw.fetch = new Proxy(origFetch, {
      apply(target, thisArg, args) {
        try {
          const input = args[0];
          let url = null;
          if (typeof input === 'string') url = input;
          else if (input instanceof uw.Request) url = input.url;
          else if (input instanceof uw.URL) url = input.href;
          if (url && ENABLE_FLAG_FLIP && url.indexOf(SETTINGS_URL_MARK) !== -1) {
            log('settings intercepted (flag flip): ' + url);
            return Reflect.apply(target, thisArg, args).then((resp) =>
              resp.text().then((t) => new uw.Response(rewriteSettingsText(t, 'fetch'), {
                status: resp.status, statusText: resp.statusText,
                headers: { 'Content-Type': 'application/json' },
              }))
            );
          }
          const file = url && matchArchivedFile(url);
          if (shouldServe(file)) {
            log('fetch intercepted: ' + url);
            return getFileBlobUrl(file).then(
              (blobUrl) => {
                log('serving archived bytes for ' + file);
                return Reflect.apply(target, thisArg, [blobUrl, args[1]]);
              },
              (err) => {
                warn('archive unavailable for ' + file + ', falling back to original URL:', err);
                return Reflect.apply(target, thisArg, args);
              }
            );
          }
        } catch (e) { warn('fetch hook error:', e); }
        return Reflect.apply(target, thisArg, args);
      }
    });
    log('fetch() patched.');
  } catch (e) { warn('could not patch fetch:', e); }

  // --- XMLHttpRequest (open/send/setRequestHeader) --- (in FULL-LOCAL MODE only embedded/forged entries are served)
  if (!FULL_LOCAL_MODE || FORGED_PATCH_CONFIG) try {
    const XHRProto = uw.XMLHttpRequest.prototype;
    const origOpen = XHRProto.open;
    const origSend = XHRProto.send;
    const origSetHdr = XHRProto.setRequestHeader;

    XHRProto.open = new Proxy(origOpen, {
      apply(target, thisArg, args) {
        try {
          if (ENABLE_FLAG_FLIP && typeof args[1] === 'string' && args[1].indexOf(SETTINGS_URL_MARK) !== -1) trapSettingsXHR(thisArg);
          thisArg.__rbxFile = typeof args[1] === 'string' ? matchArchivedFile(args[1]) : null;
          if (!shouldServe(thisArg.__rbxFile)) thisArg.__rbxFile = null;
          thisArg.__rbxSwapped = false;
          thisArg.__rbxOpenArgs = Array.prototype.slice.call(args);
          thisArg.__rbxHeaders = [];
        } catch (e) { /* ignore */ }
        return Reflect.apply(target, thisArg, args);
      }
    });

    XHRProto.setRequestHeader = new Proxy(origSetHdr, {
      apply(target, thisArg, args) {
        try {
          if (thisArg.__rbxFile && !thisArg.__rbxSwapped) {
            thisArg.__rbxHeaders.push([args[0], args[1]]);
          }
        } catch (e) { /* ignore */ }
        return Reflect.apply(target, thisArg, args);
      }
    });

    XHRProto.send = new Proxy(origSend, {
      apply(target, thisArg, args) {
        try {
          if (thisArg.__rbxFile && !thisArg.__rbxSwapped) {
            const file = thisArg.__rbxFile;
            const openArgs = thisArg.__rbxOpenArgs || [];
            const isAsync = openArgs.length < 3 || openArgs[2] !== false;
            if (!isAsync) {
              warn('synchronous XHR for ' + file + ' detected; leaving untouched.');
              return Reflect.apply(target, thisArg, args);
            }
            thisArg.__rbxSwapped = true;
            log('XHR intercepted: ' + openArgs[1]);
            getFileBlobUrl(file).then(
              (blobUrl) => {
                try {
                  const savedType = thisArg.responseType;
                  const savedCred = thisArg.withCredentials;
                  const savedTimeout = thisArg.timeout;
                  const newArgs = openArgs.slice();
                  newArgs[1] = blobUrl;
                  Reflect.apply(origOpen, thisArg, newArgs);
                  try { thisArg.responseType = savedType; } catch (e) { /* ignore */ }
                  try { thisArg.withCredentials = savedCred; } catch (e) { /* ignore */ }
                  try { thisArg.timeout = savedTimeout; } catch (e) { /* ignore */ }
                  (thisArg.__rbxHeaders || []).forEach((h) => {
                    try { Reflect.apply(origSetHdr, thisArg, h); } catch (e) { /* ignore */ }
                  });
                  log('serving archived bytes for XHR ' + file);
                  Reflect.apply(origSend, thisArg, args);
                } catch (err) {
                  warn('XHR redirect failed, trying original URL:', err);
                  try {
                    Reflect.apply(origOpen, thisArg, openArgs);
                    Reflect.apply(origSend, thisArg, args);
                  } catch (e2) { /* give up */ }
                }
              },
              (err) => {
                warn('archive unavailable for ' + file + ', falling back to original URL:', err);
                try { Reflect.apply(target, thisArg, args); } catch (e) { /* ignore */ }
              }
            );
            return; // async path: original send() is suppressed
          }
        } catch (e) { warn('XHR hook error:', e); }
        return Reflect.apply(target, thisArg, args);
      }
    });
    log('XMLHttpRequest patched.');
  } catch (e) { warn('could not patch XMLHttpRequest:', e); }

  // --- WebAssembly.instantiateStreaming / compileStreaming (defense in depth) --- (skipped in FULL-LOCAL MODE)
  if (!FULL_LOCAL_MODE) try {
    const WAS = uw.WebAssembly;
    const pageFetch = Function.prototype.call.bind(uw.fetch); // the patched fetch
    const isEngineWasm = (u) => typeof u === 'string' &&
      (u.indexOf(ENGINE_VERSION_DIR) !== -1 || u.indexOf('WebClient.wasm') !== -1);

    if (WAS && WAS.instantiateStreaming) {
      const origIS = WAS.instantiateStreaming;
      WAS.instantiateStreaming = new Proxy(origIS, {
        apply(target, thisArg, args) {
          return (async () => {
            const resp = await args[0]; // rejects exactly like the original on failure
            if (resp && isEngineWasm(resp.url)) {
              log('instantiateStreaming intercepted: ' + resp.url);
              const blobUrl = await getFileBlobUrl('WebClient.wasm');
              return Reflect.apply(target, thisArg, [pageFetch(uw, blobUrl), args[1]]);
            }
            return Reflect.apply(target, thisArg, [resp, args[1]]);
          })();
        }
      });
      log('WebAssembly.instantiateStreaming patched.');
    }

    if (WAS && WAS.compileStreaming) {
      const origCS = WAS.compileStreaming;
      WAS.compileStreaming = new Proxy(origCS, {
        apply(target, thisArg, args) {
          return (async () => {
            const resp = await args[0];
            if (resp && isEngineWasm(resp.url)) {
              log('compileStreaming intercepted: ' + resp.url);
              const blobUrl = await getFileBlobUrl('WebClient.wasm');
              return Reflect.apply(target, thisArg, [pageFetch(uw, blobUrl)]);
            }
            return Reflect.apply(target, thisArg, [resp]);
          })();
        }
      });
      log('WebAssembly.compileStreaming patched.');
    }
  } catch (e) { warn('could not patch WebAssembly streaming:', e); }

  // --- Worker bootstrap for pthread workers (v1.3) ---
  // Emscripten spawns pthread workers via `new Worker(stub.js?src=<CDN WebClient.js>)`
  // and stub.js then importScripts() the engine. Worker-context requests bypass
  // DevTools Local Overrides, so importScripts hits the dead CDN and fails.
  // (This patch stays active in FULL-LOCAL MODE — it is the one thing Local
  // Overrides provably cannot do in some Chrome versions.)
  // Fix: swap those workers for blob: workers (allowed by worker-src) whose
  // source IS WebClient.js (fetched once through the working main-thread
  // override). WebClient.js contains no importScripts/location logic, so running
  // it directly is behaviorally identical to stub->importScripts.
  const WEBCLIENT_JS_URL = 'https://setup.rbxcdn.com/webclient/' + ENGINE_VERSION_DIR + '/WebClient.js';
  let webclientJsText = null;   // sync cache, filled ASAP after document-start
  let webclientJsPromise = null;
  let workerBootstrapUrl = null;

  function fetchWebClientJsText() {
    if (!webclientJsPromise) {
      webclientJsPromise = (async () => {
        log('prefetching WebClient.js source (worker bootstrap)…');
        const resp = await uw.fetch(WEBCLIENT_JS_URL); // served by the Local Override
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const text = await resp.text();
        if (text.length < 50000 || text.indexOf('createWebClient') === -1) {
          throw new Error('validation failed (' + text.length + ' chars, missing markers — override absent?)');
        }
        webclientJsText = text;
        log('WebClient.js source cached (' + (text.length / 1024).toFixed(1) + ' KB).');
        return text;
      })().catch((err) => {
        webclientJsPromise = null; // allow retry
        warn('WebClient.js prefetch failed (engine workers will use original URL):', err);
        throw err;
      });
    }
    return webclientJsPromise;
  }
  fetchWebClientJsText().catch(() => {}); // fire ASAP; workers spawn seconds later
  // v1.8: retry aggressively — DevTools Local Overrides can attach AFTER
  // document-start scripts run, so the first prefetch sometimes 403s while
  // later loads succeed (observed: prefetch failed at load, cached 252.6 KB
  // mid-run, all 18 workers already dead). Workers spawn ~4s in, so retry
  // until bytes land or 10s pass.
  (function bootstrapRetryLoop() {
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      if (webclientJsText || tries > 25) { clearInterval(iv); return; }
      fetchWebClientJsText().then(
        () => clearInterval(iv),
        () => { if (tries % 5 === 0) warn('WebClient.js bootstrap retry ' + tries + '… (is DevTools open with overrides attached?)'); }
      );
    }, 400);
  })();

  function getWorkerBootstrapUrl() {
    if (!webclientJsText) return null; // bytes not ready yet (Worker() is sync!)
    if (!workerBootstrapUrl) {
      // NOTE: Blob + object URL use PAGE-world constructors so the page's
      // Worker gets a same-world blob: URL (only a string crosses worlds).
      const blob = new uw.Blob(
        [webclientJsText + '\n//# sourceURL=WebClient.js (baked-blob-worker)'],
        { type: 'text/javascript' }
      );
      workerBootstrapUrl = uw.URL.createObjectURL(blob);
      log('worker bootstrap blob URL ready.');
    }
    return workerBootstrapUrl;
  }

  try {
    const OrigWorker = uw.Worker;
    uw.Worker = new Proxy(OrigWorker, {
      construct(target, args) {
        try {
          const urlStr = String(args[0]);
          const isEngineWorker = urlStr.indexOf('stub.js') !== -1 ||
            (urlStr.indexOf(ENGINE_VERSION_DIR) !== -1 && urlStr.indexOf('WebClient.js') !== -1);
          if (isEngineWorker) {
            const blobUrl = getWorkerBootstrapUrl();
            if (blobUrl) {
              log('Worker intercepted \u2192 baked blob worker (' + urlStr.slice(0, 100) + '…)');
              return Reflect.construct(target, [blobUrl, args[1]]);
            }
            warn('worker bootstrap bytes not ready; using original URL (this worker may fail).');
            fetchWebClientJsText().catch(() => {}); // retry in background
          }
        } catch (e) { warn('Worker hook error:', e); }
        return Reflect.construct(target, args);
      }
    });
    log('Worker() patched.');
  } catch (e) { warn('could not patch Worker:', e); }

  try {
    uw.__rbxWasmArchiveRedirect = {
      active: true,
      placeIds: TARGET_PLACE_IDS,
      engineDir: ENGINE_VERSION_DIR,
      files: Object.keys(ARCHIVE_FILES),
      workerBootstrap: true,
      fullLocalMode: FULL_LOCAL_MODE,
      forgedPatchConfig: !!FORGED_PATCH_CONFIG,
      version: '2.1.0'
    };
  } catch (e) { /* ignore */ }

  log('ready. Open DevTools console to watch for interception messages.');
})();
