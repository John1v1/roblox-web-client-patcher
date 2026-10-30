// Private guided page. No Roblox login, account token, analytics, or relay secrets.
// Public username lookup uses CORS-enabled GET requests to the third-party
// RoProxy mirror; the fixed same-origin endpoint is a fallback. Manual ID needs
// no lookup. All downloads are made from this private project's own assets.
const $ = id => document.getElementById(id);
const screens = [...document.querySelectorAll('[data-screen]')];
const progress = [...document.querySelectorAll('[data-progress]')];
const placeInput = $('place-id');
const quickPlaceInput = $('quick-place-id');
const usernameInput = $('username');
const gamesList = $('games-list');
const lookupStatus = $('lookup-status');
const setupButton = $('download-setup');
const quickSetupButton = $('quick-download-setup');
const payloadButton = $('download-payload');
const quickPayloadButton = $('quick-download-payload');
const userscriptButton = $('download-userscript');
const copyScriptButton = $('copy-userscript');
const finalUrl = $('final-url');
const openGame = $('open-game');
const nextButton = $('next-button');
const backButton = $('back-button');
const wizardNav = $('wizard-nav');
const haveFiles = $('have-files');
const URL_PREFIX = 'https://play.roblox.com/games/start?placeId=';
const PLACE_PATTERN = /^[1-9][0-9]{0,18}$/;
const steps = ['get ready', 'choose game', 'get files', 'set up Chrome', 'launch'];
const session = { step: 0, special: null, files: { setup: false, payload: false }, lookupId: 0 };
const lookupCache = new Map();

function value() { return placeInput.value.trim(); }
function validPlace() { return PLACE_PATTERN.test(value()); }
function saveSession() {
  try { sessionStorage.setItem('webclient-rescue-place', value()); sessionStorage.setItem('webclient-rescue-step', String(session.step)); }
  catch { /* Storage is optional. */ }
}
function render() {
  const special = session.special;
  screens.forEach((section, i) => { section.hidden = Boolean(special) || i !== session.step; });
  $('python-help').hidden = special !== 'python';
  $('developer-help').hidden = special !== 'developer';
  wizardNav.hidden = Boolean(special);
  progress.forEach((item, i) => {
    item.classList.toggle('active', !special && i === session.step);
    item.classList.toggle('complete', !special && i < session.step);
    if (!special && i === session.step) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
  backButton.disabled = session.step === 0;
  $('step-counter').textContent = `Step ${session.step} of 5`;
  nextButton.hidden = session.step === 5;
  if (session.step < 5) nextButton.textContent = 'Next: ' + steps[session.step] + ' →';
  nextButton.disabled = (session.step === 2 && !validPlace()) ||
    (session.step === 3 && !(session.files.setup && session.files.payload) && !haveFiles.checked);
}
function navigate(step, special = null) {
  session.step = Math.min(5, Math.max(0, step));
  session.special = special;
  render(); saveSession();
  document.querySelector(special ? '#' + special + '-help h1' : `[data-screen="${session.step}"] h1`).focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function setStatus(node, text, kind = '') {
  node.textContent = text;
  node.className = 'field-status' + (kind ? ' ' + kind : '');
}
function setDownloadStatus(text, kind = '') {
  setStatus($('download-status'), text, kind);
  setStatus($('quick-status'), text, kind);
}
function updatePlace(source = placeInput) {
  if (source === quickPlaceInput) placeInput.value = quickPlaceInput.value;
  else quickPlaceInput.value = placeInput.value;
  const id = value();
  const valid = validPlace();
  for (const item of gamesList.querySelectorAll('.game-option')) {
    item.classList.toggle('selected', item.dataset.placeId === id);
    item.setAttribute('aria-pressed', String(item.dataset.placeId === id));
    item.querySelector('.option-check').textContent = item.dataset.placeId === id ? '✓' : '';
  }
  for (const input of [placeInput, quickPlaceInput]) input.setAttribute('aria-invalid', String(Boolean(id) && !valid));
  if (session.lastPlace !== id) {
    session.files.setup = false; session.lastPlace = id;
    if (session.files.payload) setDownloadStatus('Place changed. Download a fresh setup.py for this ID.', 'error');
  }
  setupButton.disabled = quickSetupButton.disabled = !valid;
  userscriptButton.disabled = copyScriptButton.disabled = !valid;
  $('copy-url').disabled = !valid;
  finalUrl.textContent = valid ? URL_PREFIX + id : 'Choose a place in Step 2.';
  if (valid) {
    openGame.href = URL_PREFIX + id;
    openGame.removeAttribute('aria-disabled');
  } else {
    openGame.removeAttribute('href');
    openGame.setAttribute('aria-disabled', 'true');
  }
  render(); saveSession();
}
placeInput.addEventListener('input', () => updatePlace(placeInput));
quickPlaceInput.addEventListener('input', () => updatePlace(quickPlaceInput));
backButton.addEventListener('click', () => navigate(session.step - 1));
nextButton.addEventListener('click', () => { if (!nextButton.disabled) navigate(session.step + 1); });
$('python-help-button').addEventListener('click', () => navigate(1, 'python'));
$('developer-button').addEventListener('click', () => navigate(1, 'developer'));
for (const button of document.querySelectorAll('[data-return-guide]')) {
  button.addEventListener('click', () => navigate(1));
}
haveFiles.addEventListener('change', render);

async function publicJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { credentials: 'omit', ...options, signal: controller.signal });
    if (!response.ok) throw new Error('Public lookup returned HTTP ' + response.status);
    return await response.json();
  } finally { clearTimeout(timer); }
}
async function directLookup(username) {
  let user = null;
  let userCursor = null;
  for (let page = 0; page < 3; page++) {
    const params = new URLSearchParams({ keyword: username, limit: '50' });
    if (userCursor) params.set('cursor', userCursor);
    const users = await publicJson('https://users.roproxy.com/v1/users/search?' + params);
    user = Array.isArray(users.data) ? users.data.find(item =>
      String(item.name || '').toLowerCase() === username.toLowerCase()) : null;
    if (user) break;
    userCursor = users.nextPageCursor;
    if (!userCursor) break;
  }
  if (!user || !Number.isSafeInteger(user.id) || user.id < 1) return { user: null, games: [] };
  const games = [];
  let cursor = null;
  for (let page = 0; page < 5; page++) {
    const params = new URLSearchParams({ accessFilter: 'Public', limit: '50', sortOrder: 'Asc' });
    if (cursor) params.set('cursor', cursor);
    const result = await publicJson('https://games.roproxy.com/v2/users/' + user.id + '/games?' + params);
    if (!Array.isArray(result.data)) throw new Error('Unexpected public-games response');
    for (const game of result.data) {
      const place = game.rootPlace && game.rootPlace.id;
      if (Number.isSafeInteger(place) && place > 0)
        games.push({ placeId: String(place), name: String(game.name || 'Untitled') });
    }
    cursor = result.nextPageCursor;
    if (!cursor) break;
  }
  return { user: { id: user.id, name: user.name }, games, truncated: Boolean(cursor) };
}
async function fallbackLookup(username) {
  const response = await fetch('/api/roblox-games?username=' + encodeURIComponent(username), { credentials: 'same-origin' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Public lookup is unavailable');
  return data;
}
$('lookup-form').addEventListener('submit', async event => {
  event.preventDefault();
  const username = usernameInput.value.trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    setStatus(lookupStatus, 'Enter a Roblox username with 3–20 letters, numbers, or underscores.', 'error'); return;
  }
  const requestId = ++session.lookupId;
  gamesList.hidden = true;
  gamesList.replaceChildren();
  $('find-games').disabled = true;
  setStatus(lookupStatus, 'Looking up public games for @' + username + '…');
  try {
    let data = lookupCache.get(username.toLowerCase());
    if (!data) {
      try { data = await directLookup(username); }
      catch { data = await fallbackLookup(username); }
      lookupCache.set(username.toLowerCase(), data);
    }
    if (requestId !== session.lookupId) return;
    if (!data.user) {
      setStatus(lookupStatus, 'No exact username found. Check the spelling, or enter a Place ID manually.', 'error'); return;
    }
    for (const game of (Array.isArray(data.games) ? data.games : [])) {
      const id = String(game.placeId || '');
      if (!PLACE_PATTERN.test(id)) continue;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'game-option'; button.dataset.placeId = id;
      button.setAttribute('aria-pressed', String(id === value()));
      const title = document.createElement('span');
      const name = document.createElement('strong'); name.textContent = String(game.name || 'Untitled');
      const subtitle = document.createElement('small'); subtitle.textContent = 'Place ID ' + id;
      title.append(name, subtitle);
      const check = document.createElement('span'); check.className = 'option-check';
      check.setAttribute('aria-hidden', 'true'); check.textContent = id === value() ? '✓' : '';
      button.classList.toggle('selected', id === value());
      button.append(title, check);
      button.addEventListener('click', () => { placeInput.value = id; updatePlace(placeInput); });
      gamesList.append(button);
    }
    gamesList.hidden = gamesList.childElementCount === 0;
    setStatus(lookupStatus, gamesList.childElementCount
      ? `Found ${gamesList.childElementCount} public game(s) for @${data.user.name}. Choose one below.${data.truncated ? ' More may be available; you can enter a Place ID manually.' : ''}`
      : `No public games found for @${data.user.name}. Enter a Place ID manually.`, gamesList.childElementCount ? 'success' : 'error');
  } catch {
    if (requestId === session.lookupId)
      setStatus(lookupStatus, 'Public lookup is unavailable right now. Enter your Place ID manually.', 'error');
  } finally { if (requestId === session.lookupId) $('find-games').disabled = false; }
});

function downloadBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = href; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 120000);
}
async function downloadSetup() {
  if (!validPlace()) return;
  const id = value();
  setupButton.disabled = quickSetupButton.disabled = true;
  try {
    const response = await fetch('./setup.py', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Cannot load setup.py from this private project.');
    const text = await response.text();
    const marker = 'DEFAULT_PLACE_ID = "URPLACEID"';
    if (text.split(marker).length !== 2) throw new Error('Installer is missing its Place ID marker.');
    downloadBlob(new Blob([text.replace(marker, 'DEFAULT_PLACE_ID = "' + id + '"')], { type: 'text/x-python' }), 'setup.py');
    session.files.setup = value() === id;
    setDownloadStatus('Personalized setup.py downloaded for Place ID ' + id + '. Keep it beside the ZIP.', 'success');
  } catch (error) { setDownloadStatus(error.message || 'Cannot prepare setup.py.', 'error'); }
  finally { setupButton.disabled = quickSetupButton.disabled = !validPlace(); render(); }
}
setupButton.addEventListener('click', downloadSetup);
quickSetupButton.addEventListener('click', downloadSetup);
async function sha256(bytes) {
  if (!crypto || !crypto.subtle) throw new Error('Browser cannot verify the ZIP. Use the three manual part links.');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function downloadPayload() {
  payloadButton.disabled = quickPayloadButton.disabled = true;
  try {
    const config = await fetch('./delivery.json', { credentials: 'same-origin' });
    if (!config.ok) throw new Error('Cannot load the part manifest.');
    const plan = await config.json();
    if (plan.schema !== 1 || !Array.isArray(plan.parts) || plan.parts.length !== 3 ||
        plan.parts.some((part, i) => part.name !== 'payload.part' + (i + 1))) throw new Error('Unexpected payload manifest.');
    const pieces = [];
    for (let i = 0; i < plan.parts.length; i++) {
      const spec = plan.parts[i];
      setDownloadStatus('Downloading part ' + (i + 1) + ' of 3…');
      const response = await fetch('./' + spec.name, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(spec.name + ' returned HTTP ' + response.status + '.');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== spec.size || await sha256(bytes) !== spec.sha256)
        throw new Error(spec.name + ' failed size or SHA-256 verification.');
      pieces.push(bytes);
    }
    setDownloadStatus('Verifying the complete ZIP…');
    const blob = new Blob(pieces, { type: 'application/zip' });
    if (blob.size !== plan.bundle_size || await sha256(await blob.arrayBuffer()) !== plan.bundle_sha256)
      throw new Error('Combined ZIP failed verification.');
    downloadBlob(blob, 'webclient-rescue-payload.zip');
    session.files.payload = true;
    setDownloadStatus('Verified payload ZIP downloaded. Keep it in the same folder as setup.py.', 'success');
  } catch (error) { setDownloadStatus((error.message || 'Download failed.') + ' Try the manual part links.', 'error'); }
  finally { payloadButton.disabled = quickPayloadButton.disabled = false; render(); }
}
payloadButton.addEventListener('click', downloadPayload);
quickPayloadButton.addEventListener('click', downloadPayload);
async function personalizedUserscript() {
  const id = value();
  const response = await fetch('./payload/roblox-webclient-rescue.user.js', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('Could not load the private userscript asset.');
  let text = await response.text();
  const marker = "const TARGET_PLACE_IDS = ['7435428319', '104612064449158'];";
  if (text.split(marker).length !== 2 || !text.includes('// ==UserScript==')) throw new Error('Unexpected userscript template.');
  return text.replace(marker, "const TARGET_PLACE_IDS = ['" + id + "'];")
    .replace(/^\/\/ @name\s+.*$/m, '// @name         WebClient rescue (place ' + id + ')');
}
userscriptButton.addEventListener('click', async () => {
  if (!validPlace()) return;
  userscriptButton.disabled = true;
  try {
    const text = await personalizedUserscript();
    downloadBlob(new Blob([text], { type: 'text/javascript' }), 'roblox-webclient-rescue.user.js');
    setStatus($('userscript-status'), 'Personalized userscript downloaded. Install and enable it in Tampermonkey.', 'success');
  } catch (error) { setStatus($('userscript-status'), error.message || 'Userscript download failed.', 'error'); }
  finally { userscriptButton.disabled = copyScriptButton.disabled = !validPlace(); }
});
copyScriptButton.addEventListener('click', async () => {
  if (!validPlace()) return;
  copyScriptButton.disabled = true;
  try {
    const text = await personalizedUserscript();
    await navigator.clipboard.writeText(text);
    setStatus($('userscript-status'), 'Userscript copied. In Tampermonkey, choose Dashboard → Add a new script, paste, and save.', 'success');
  } catch (error) { setStatus($('userscript-status'), error.message === 'Could not load the private userscript asset.' || error.message.startsWith('Unexpected') ? error.message : 'Copy failed. Use Download instead.', 'error'); }
  finally { copyScriptButton.disabled = userscriptButton.disabled = !validPlace(); }
});
$('copy-url').addEventListener('click', async () => {
  if (!validPlace()) return;
  try {
    await navigator.clipboard.writeText(URL_PREFIX + value());
    const button = $('copy-url'); button.textContent = 'Copied!';
    setTimeout(() => { button.textContent = 'Copy URL'; }, 2500);
  } catch { $('copy-url').textContent = 'Select URL above to copy'; }
});

try {
  const savedPlace = sessionStorage.getItem('webclient-rescue-place');
  if (savedPlace && PLACE_PATTERN.test(savedPlace)) placeInput.value = savedPlace;
  const savedStep = Number(sessionStorage.getItem('webclient-rescue-step'));
  if (Number.isInteger(savedStep) && savedStep >= 0 && savedStep <= 5) session.step = savedStep;
} catch { /* Storage is optional. */ }
updatePlace();
