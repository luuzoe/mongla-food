/* Mong La Food Delivery — main app (Supabase Auth + Postgres, no build step)
 * UI 与视图逻辑和 Firebase 版完全一致，只换了数据层。
 * UI and view logic are identical to the Firebase version — only the
 * data layer changed to Supabase.
 */
let currentUser = null;      // supabase auth user ({id, email, ...})
let userDoc = null;          // mapped row from public.users {role, name, email, phone}
let unsubs = [];             // active realtime channels
let cart = { items: {} };  // multi-shop cart: items keyed by shopId + "__" + itemId
let shopTab = "menu";        // shop detail tab
let homeFilter = { q: "", cat: "all" };
let vendorTab = "info";
let showPostForm = false;
let showShopForm = false;
let showMenuForm = false;
let adminTab = "shops";

/* ---------- row mappers (Supabase snake_case -> app camelCase) ---------- */
function mapUser(r) {
  if (!r) return null;
  const nm = ((r.first_name || "") + " " + (r.last_name || "")).trim();
  return { id: r.id, role: r.role, name: nm || r.email || "", first_name: r.first_name, last_name: r.last_name, email: r.email, phone: r.phone };
}
function mapShop(r) {
  if (!r) return r;
  return {
    id: r.id, name_zh: r.name_zh, name_my: r.name_my, name_en: r.name_en,
    ownerName: r.owner_name, address_zh: r.address_zh, address_my: r.address_my,
    phone: r.phone, category: r.category, emoji: r.emoji, sample: r.sample,
    deliveryFee: Number(r.delivery_fee_yuan) || 0, wechatId: r.wechat_id || "",
    photo_url: r.photo_url || null,
    ownerUid: r.owner_id, createdAt: r.created_at
  };
}
function mapItem(r) {
  if (!r) return r;
  return {
    id: r.id, shop_id: r.shop_id, category: r.category,
    name_zh: r.name_zh, name_my: r.name_my, name_en: r.name_en,
    price: Number(r.price_yuan) || 0, emoji: r.emoji, photoUrl: r.photo_url,
    available: r.available, sample: r.sample
  };
}
function mapConv(r) {
  if (!r) return r;
  return {
    id: r.id, shopId: r.shop_id, customerUid: r.customer_id, vendorUid: r.vendor_id,
    customerName: r.customer_name, lastMessageAt: r.last_message_at, createdAt: r.created_at,
    customerReadAt: r.customer_last_read_at, vendorReadAt: r.vendor_last_read_at
  };
}
function mapMsg(r) {
  if (!r) return r;
  return {
    id: r.id, conversation_id: r.conversation_id, senderUid: r.sender_id,
    senderRole: r.sender_role, type: r.kind, text: r.body, items: r.items,
    total: Number(r.total_yuan) || 0, orderId: r.order_id, createdAt: r.created_at,
    mediaUrl: r.media_url || ""
  };
}
function mapOrder(r) {
  if (!r) return r;
  return {
    id: r.id, shopId: r.shop_id, customerUid: r.customer_id, vendorUid: r.vendor_id,
    items: r.items, total: Number(r.total_yuan) || 0, status: r.status,
    deliveryAddress: r.delivery_address || "", customerPhone: r.customer_phone || "",
    note: r.note || "", deliveryFee: Number(r.delivery_fee_yuan) || 0,
    convId: r.conversation_id, customerName: r.customer_name,
    customerEmail: r.customer_email, createdAt: r.created_at
  };
}
function mapPost(r) {
  if (!r) return r;
  return {
    id: r.id, shopId: r.shop_id, vendorUid: r.vendor_id,
    body: r.body || "", price: Number(r.price_yuan) || 0,
    photoUrl: r.photo_url || "", createdAt: r.created_at,
    category: r.category || "foods"
  };
}

/* ---------- helpers ---------- */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtTime(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts); // Supabase returns ISO strings for timestamptz
    const loc = LANG === "en" ? "en-US" : (LANG === "my" ? "my-MM" : "zh-CN");
    return d.toLocaleString(loc, { hour12: false });
  } catch (e) { return ""; }
}
function stopListeners() {
  if (typeof sb !== "undefined" && sb) {
    unsubs.forEach(ch => { try { sb.removeChannel(ch); } catch (e) {} });
  }
  unsubs = [];
}
function money(n) { return "¥" + Number(n || 0).toFixed(0); }
/* ---------- in-app toast + confirm modal (replaces native alert/confirm) ---------- */
function ensureModal() {
  let ov = document.getElementById("appModal");
  if (ov) return ov;
  ov = document.createElement("div");
  ov.id = "appModal";
  ov.className = "modal-overlay";
  ov.innerHTML = '<div class="modal-card"><div class="modal-msg" id="modalMsg"></div>' +
    '<div class="modal-btns" id="modalBtns"></div></div>';
  document.body.appendChild(ov);
  return ov;
}
/* toast(msg): brief in-site popup, auto-dismisses. Message may include emoji. */
function toast(msg) {
  const ov = ensureModal();
  document.getElementById("modalMsg").textContent = msg;
  document.getElementById("modalBtns").innerHTML = "";
  ov.classList.add("open");
  clearTimeout(window._toastT);
  window._toastT = setTimeout(() => ov.classList.remove("open"), 2200);
}
/* user preferences (localStorage): default address/phone + notification toggle */
function getPref(k, dflt) {
  try { const v = localStorage.getItem("mf_" + k); return v == null ? dflt : v; }
  catch (e) { return dflt; }
}
function setPref(k, v) {
  try { localStorage.setItem("mf_" + k, v); } catch (e) {}
}
/* notifyPing(msg): toast + soft beep for realtime events, honoring the notif toggle */
let _ac = null;
function beep() {
  try {
    _ac = _ac || new (window.AudioContext || window.webkitAudioContext)();
    const o = _ac.createOscillator(), g = _ac.createGain();
    o.connect(g); g.connect(_ac.destination);
    o.frequency.value = 880; o.type = "sine";
    g.gain.setValueAtTime(0.12, _ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, _ac.currentTime + 0.3);
    o.start(); o.stop(_ac.currentTime + 0.3);
  } catch (e) {}
}
/* favourites: star on dish cards, favourited dishes sort first (localStorage) */
function getFavs() {
  try { return JSON.parse(getPref("favs", "[]")) || []; } catch (e) { return []; }
}
function isFav(key) { return getFavs().indexOf(key) >= 0; }
function toggleFav(key) {
  const f = getFavs();
  const i = f.indexOf(key);
  if (i >= 0) f.splice(i, 1); else f.push(key);
  setPref("favs", JSON.stringify(f));
  drawDishGrid();
  try { renderFeedPosts(); } catch (e) {}
  try { renderShopPosts(); } catch (e) {}
}
function notifyPing(msg) {
  if (getPref("notif", "1") !== "1") return;
  if (msg) toast(msg);
  beep();
}
/* confirmDlg(msg): in-site confirm dialog, resolves true/false. */
function confirmDlg(msg) {  return new Promise((resolve) => {
    const ov = ensureModal();
    clearTimeout(window._toastT);
    document.getElementById("modalMsg").textContent = msg;
    const btns = document.getElementById("modalBtns");
    btns.innerHTML = "";
    const bNo = document.createElement("button");
    bNo.className = "btn gray"; bNo.textContent = t("cancel");
    const bYes = document.createElement("button");
    bYes.className = "btn"; bYes.textContent = t("ok");
    const done = (v) => { ov.classList.remove("open"); resolve(v); };
    bNo.onclick = () => done(false);
    bYes.onclick = () => done(true);
    btns.appendChild(bNo); btns.appendChild(bYes);
    ov.classList.add("open");
  });
}
function cartCount() {
  return Object.values(cart.items).reduce((a, it) => a + it.qty, 0);
}
function cartTotal() {
  return Object.values(cart.items).reduce((a, it) => a + it.qty * it.price, 0);
}

/* ---------- boot ---------- */
window.addEventListener("DOMContentLoaded", boot);
function boot() {
  try {
    document.getElementById("logoBtn").onclick = () => { location.hash = "#/"; };
    document.getElementById("menuBtn").onclick = () => openDrawer();
    document.getElementById("drawerClose").onclick = () => closeDrawer();
    document.getElementById("drawerOverlay").onclick = () => closeDrawer();
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
    if (!SUPABASE_CONFIG_OK) {
      document.getElementById("app").innerHTML =
        '<div class="notice">⚠️ ' + esc(t("setupNeeded")) + "<br><br>" +
        "README-my.md</div>";
      return;
    }
    sb.auth.onAuthStateChange(async (_event, session) => { await handleSession(session); });
    sb.auth.getSession().then(async ({ data }) => { await handleSession(data.session); });
    window.addEventListener("hashchange", renderAll);
    // Safety net: if auth bootstrap stalls, show a message instead of hanging on "…".
    setTimeout(() => {
      const app = document.getElementById("app");
      if (app && app.innerHTML.trim() === "…") {
        app.innerHTML = '<div class="notice">⚠️ ' + esc(t("bootStuck")) + "</div>";
      }
    }, 12000);
  } catch (e) {
    document.getElementById("app").innerHTML =
      '<div class="notice">⚠️ ' + esc(String((e && e.message) || e)) + "</div>";
  }
}
async function handleSession(session) {
  currentUser = (session && session.user) ? session.user : null;
  userDoc = null;
  if (!currentUser) {
    if (typeof _gcCh !== "undefined" && _gcCh) { try { sb.removeChannel(_gcCh); } catch (e) {} }
    if (typeof _gcCh !== "undefined") _gcCh = null;
    window._totalUnread = 0; window._tuAt = 0; window._chatsLastMsg = {};
  }
  if (currentUser) {
    try {
      const { data, error } = await sb.from("users").select("*").eq("id", currentUser.id).single();
      if (!error && data) {
        userDoc = mapUser(data);
      } else {
        // First login via OAuth (e.g. Google): create the profile row.
        // (Email signups insert their own row in doCreateAccount.)
        const { error: insErr } = await sb.from("users").insert({
          id: currentUser.id, role: "customer",
          first_name: "", last_name: "",
          email: currentUser.email || "", phone: ""
        });
        if (!insErr) {
          const r2 = await sb.from("users").select("*").eq("id", currentUser.id).single();
          if (!r2.error && r2.data) userDoc = mapUser(r2.data);
        }
      }
    } catch (e) { console.warn("userDoc load failed", e); }
  }
  renderAll();
}

/* ---------- header + side drawer ---------- */
function renderHeader() {
  renderTapbar();
  ensureGlobalChatWatch();
  document.querySelectorAll("[data-i18n]").forEach(el => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  renderDrawer();
}
/* Side menu (top-left ☰): Profile, Settings, Help, Contact Us, Logout. */
function openDrawer() {
  renderDrawer();
  document.getElementById("drawer").classList.add("open");
  document.getElementById("drawerOverlay").classList.add("open");
}
function closeDrawer() {
  document.getElementById("drawer").classList.remove("open");
  document.getElementById("drawerOverlay").classList.remove("open");
}
function renderDrawer() {
  const box = document.getElementById("drawerItems");
  if (!box) return;
  const items = [
    { icon: "👤", label: t("profile"), hash: "#/profile" },
    { icon: "📦", label: t("orders"), hash: "#/orders" },
    { icon: "⚙️", label: t("settings"), hash: "#/settings" },
    { icon: "❓", label: t("help"), hash: "#/help" },
    { icon: "📞", label: t("contactUs"), hash: "#/contact" },
    { icon: "🚪", label: t("logout"), hash: "#/logout" }
  ];
  box.innerHTML = items.map((it, i) =>
    '<div class="drawer-item" data-i="' + i + '"><span>' + it.icon + "</span><span>" + esc(it.label) + "</span></div>"
  ).join("");
  box.querySelectorAll(".drawer-item").forEach(el => {
    el.onclick = () => {
      const it = items[Number(el.getAttribute("data-i"))];
      closeDrawer();
      if (it.hash === "#/logout") {
        if (currentUser) { doLogout(); } else { location.hash = "#/profile"; }
      } else {
        location.hash = it.hash;
      }
    };
  });
}

/* ---------- router ---------- */
function renderAll() {
  stopListeners();
  renderHeader();
  const h = location.hash || "#/";
  const app = document.getElementById("app");
  document.getElementById("cartbar").innerHTML = "";
  if (h.startsWith("#/shop/")) { const id = h.split("/")[2]; return viewShop(id); }
  if (h === "#/cart") return viewCart();
  if (h === "#/orders") return viewOrders();
  if (h === "#/chats") return viewChats();
  if (h === "#/vendor") return viewVendor();
  if (h === "#/admin") return viewAdmin();
  if (h === "#/profile") return viewProfile();
  if (h === "#/settings") return viewSettings();
  if (h === "#/help") return viewHelp();
  if (h === "#/contact") return viewContact();
  if (h === "#/auth" || h === "#/register") { location.hash = "#/profile"; return; }
  return viewHome();
}
function needLogin() {
  if (!currentUser) { location.hash = "#/profile"; return true; }
  return false;
}

/* ---------- auth: profile / settings / help / contact ---------- */
let regRole = "customer";
let authMode = "register"; // register | login

/* Profile: logged in → account page; logged out → Create Account box. */
function viewProfile() {
  const app = document.getElementById("app");
  if (currentUser) {
    app.innerHTML =
      '<div class="card"><h2>👤 ' + esc(t("myAccount")) + "</h2>" +
      '<div class="profile-row"><span class="k">' + esc(t("yourName")) + "</span>" +
      '<span id="p-name-row" style="display:flex;gap:6px;align-items:center">' +
      "<span>" + esc((userDoc && userDoc.name) || currentUser.email) + "</span>" +
      '<button class="btn small gray" onclick="editProfileName()">✏️</button></span></div>' +
      '<div class="profile-row"><span class="k">' + esc(t("email")) + "</span><span>" + esc(currentUser.email || "-") + "</span></div>" +
      '<div class="profile-row"><span class="k">' + esc(t("role")) + "</span><span>" + esc((userDoc && userDoc.role) || "-") + "</span></div>" +
      '<button class="btn" style="width:100%;margin-top:10px" onclick="location.hash=\'#/orders\'">📦 ' + esc(t("orders")) + "</button>" +
      '<button class="btn" style="width:100%;margin-top:10px" onclick="doLogout()">🚪 ' + esc(t("logout")) + "</button></div>";
    return;
  }
  app.innerHTML =
    '<div class="card"><h2>' + (authMode === "login" ? "🔑 " + esc(t("login")) : "📝 " + esc(t("createAccount"))) + "</h2>" +
    (authMode === "login"
      ? '<div class="field"><label>' + esc(t("phoneOrEmail")) + '</label><input id="l-contact" placeholder="09xxxxxxxxx / you@gmail.com"></div>' +
        '<div class="field"><label>' + esc(t("password")) + '</label><input id="l-pass" type="password"></div>' +
        '<button class="btn" style="width:100%" onclick="doLogin()">' + esc(t("login")) + "</button>" +
        '<div class="center" style="margin-top:12px"><a href="javascript:void(0)" onclick="setAuthMode(\'register\')" style="color:var(--pink);font-weight:600">' + esc(t("noAccountRegister")) + "</a></div>"
      : '<div class="field"><div class="role-pick">' +
        '<div class="tab' + (regRole === "customer" ? " active" : "") + '" onclick="setRegRole(\'customer\')">' + esc(t("iAmCustomer")) + "</div>" +
        '<div class="tab' + (regRole === "vendor" ? " active" : "") + '" onclick="setRegRole(\'vendor\')">' + esc(t("iAmVendor")) + "</div>" +
        "</div></div>" +
        (regRole === "vendor"
          ? '<div class="field"><label>' + esc(t("shopName")) + '</label><input id="f-shopname"></div>' +
            '<div class="field"><label>' + esc(t("ownerName")) + '</label><input id="f-ownername"></div>'
          : '<div class="field"><label>' + esc(t("yourName")) + '</label><input id="f-name"></div>') +
        '<div class="field"><label>' + esc(t("phoneOrEmail")) + '</label><input id="f-contact" placeholder="09xxxxxxxxx / you@gmail.com"></div>' +
        '<div class="field"><label>' + esc(t("password")) + '</label><input id="f-pass2" type="password"></div>' +
        '<button class="btn" style="width:100%" onclick="doCreateAccount()">' + esc(t("createAccount")) + "</button>" +
        '<div class="center" style="margin-top:12px"><a href="javascript:void(0)" onclick="setAuthMode(\'login\')" style="color:var(--pink);font-weight:600">' + esc(t("haveAccountLogin")) + "</a></div>") +
    '<div id="auth-err" class="muted"></div></div>' +
    '<div class="card"><div class="divider">' + esc(t("signInWith")) + "</div>" +
    '<button class="social-btn" onclick="doGoogleLogin()">🔵 ' + esc(t("googleSignIn")) + "</button>" +
    '<div class="social-row">' +
    // WeChat / Facebook are shown honestly as "coming soon":
    // - WeChat login is NOT natively supported by Supabase Auth. To enable later:
    //   register at open.weixin.qq.com, complete the WeChat OAuth flow on your
    //   own server, then call sb.auth.signInWithIdToken() with the verified
    //   identity (or mint a session via a Supabase Edge Function).
    // - Facebook IS natively supported: Supabase Dashboard → Authentication →
    //   Providers → enable Facebook (needs a Facebook App ID + secret, plus the
    //   site URL in "Redirect URLs"), then call
    //   sb.auth.signInWithOAuth({ provider: "facebook" }) like doGoogleLogin().
    '<button class="social-btn" disabled>💬 ' + esc(t("wechatSignIn")) + ' <span class="soon">' + esc(t("comingSoon")) + "</span></button>" +
    '<button class="social-btn" disabled>📘 ' + esc(t("facebookSignIn")) + ' <span class="soon">' + esc(t("comingSoon")) + "</span></button></div></div>";
}
function setRegRole(r) { regRole = r; viewProfile(); }
function setAuthMode(m) { authMode = m; viewProfile(); }
async function doLogin() {
  const contact = document.getElementById("l-contact").value.trim();
  const pass = document.getElementById("l-pass").value;
  const errBox = document.getElementById("auth-err");
  const showErr = (m) => { if (errBox) errBox.textContent = "⚠️ " + m; };
  try {
    // Phone-number accounts were registered with a derived internal email.
    let email = contact;
    if (contact.indexOf("@") < 0) {
      const digits = contact.replace(/\D/g, "");
      if (!digits) throw new Error(t("enterPhoneOrEmail"));
      email = "phone_" + digits + "@phone.mongla.local";
    }
    const { data, error } = await sb.auth.signInWithPassword({ email: email, password: pass });
    if (error) throw error;
    if (!data.session) throw new Error(t("loginFailed"));
    location.hash = "#/";
  } catch (e) { showErr(e.message || e); }
}
async function doCreateAccount() {
  const isVendor = regRole === "vendor";
  const shopNm = isVendor ? document.getElementById("f-shopname").value.trim() : "";
  const ownerNm = isVendor ? document.getElementById("f-ownername").value.trim() : "";
  const custName = !isVendor ? document.getElementById("f-name").value.trim() : "";
  const contact = document.getElementById("f-contact").value.trim();
  const pass = document.getElementById("f-pass2").value;
  const errBox = document.getElementById("auth-err");
  const showErr = (m) => { if (errBox) errBox.textContent = "⚠️ " + m; };
  try {
    if (isVendor && (!shopNm || !ownerNm)) throw new Error(t("fillShopInfo"));
    if (!isVendor && !custName) throw new Error(t("enterName"));
    let email = contact, phone = "";
    if (contact.indexOf("@") < 0) {
      // Phone-number signup: Supabase email/password auth needs an email address,
      // so derive a stable internal login id and keep the real phone number in
      // the user row. (For real SMS OTP later, enable Supabase Phone Auth.)
      const digits = contact.replace(/\D/g, "");
      if (!digits) throw new Error(t("enterPhoneOrEmail"));
      email = "phone_" + digits + "@phone.mongla.local";
      phone = contact;
    }
    const { data, error } = await sb.auth.signUp({ email: email, password: pass });
    if (error) throw error;
    let user = data.user;
    if (!data.session) {
      // If "Confirm email" is ON in Supabase Auth settings, signUp returns no
      // session — try an immediate sign-in (works when Confirm email is OFF,
      // which README-my.md asks the owner to set).
      const s2 = await sb.auth.signInWithPassword({ email: email, password: pass });
      if (s2.error) throw new Error(t("checkEmailConfirm"));
      user = s2.data.user;
    }
    // upsert: the auth-state handler may already have created a customer row
    const { error: upErr } = await sb.from("users").upsert({
      id: user.id, role: regRole,
      first_name: isVendor ? ownerNm : custName,
      last_name: "",
      email: contact, phone: phone
    }, { onConflict: "id" });
    if (upErr) throw upErr;
    if (isVendor) {
      // Create the vendor's shop right away so the dashboard is ready.
      // (shopName() falls back to name_zh for all languages.)
      try {
        const ex = await sb.from("shops").select("id").eq("owner_id", user.id).limit(1);
        if (!ex.error && (!ex.data || !ex.data.length)) {
          await sb.from("shops").insert({
            name_zh: shopNm, owner_name: ownerNm, owner_id: user.id, sample: false
          });
        }
      } catch (e) { console.warn("auto shop create failed", e); }
    }
    location.hash = "#/";
  } catch (e) { showErr(e.message || e); }
}
async function doGoogleLogin() {
  const errBox = document.getElementById("auth-err");
  try {
    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + window.location.pathname }
    });
    if (error) throw error;
    // Browser redirects to Google; on return, handleSession() creates the
    // users row (role: customer) if this is the first login.
  } catch (e) { if (errBox) errBox.textContent = "⚠️ " + (e.message || e); }
}
function editProfileName() {
  const row = document.getElementById("p-name-row");
  if (!row) return;
  const cur = (userDoc && userDoc.name) || "";
  row.innerHTML = '<input id="p-name" value="' + esc(cur) + '" style="flex:1;min-width:0">' +
    '<button class="btn small" id="p-name-save">' + esc(t("save")) + "</button>";
  const inp = document.getElementById("p-name");
  inp.focus();
  document.getElementById("p-name-save").onclick = saveProfileName;
  inp.addEventListener("keydown", e => { if (e.key === "Enter") saveProfileName(); });
}
async function saveProfileName() {
  const inp = document.getElementById("p-name");
  const v = (inp && inp.value.trim()) || "";
  if (!v || !currentUser) return;
  try {
    const { error } = await sb.from("users").update({ first_name: v, last_name: "" }).eq("id", currentUser.id);
    if (error) throw error;
    // keep the name vendors see in their chat lists in sync
    await sb.from("conversations").update({ customer_name: v }).eq("customer_id", currentUser.id);
    if (userDoc) { userDoc.first_name = v; userDoc.last_name = ""; userDoc.name = v; }
    viewProfile();
    toast("\u2705");
  } catch (e) { toast("\u26A0\uFE0F " + e.message); }
}
async function doLogout() { await sb.auth.signOut(); location.hash = "#/"; }

/* Settings: language choice lives here (not the header). */
function viewSettings() {
  const app = document.getElementById("app");
  const langs = [["my", "🇲🇲 မြန်မာ"], ["zh", "🇨🇳 中文"], ["en", "🇬🇧 English"]];
  app.innerHTML =
    '<div class="card"><h2>⚙️ ' + esc(t("settings")) + "</h2>" +
    '<div class="field"><label>' + esc(t("chooseLanguage")) + "</label>" +
    langs.map(([id, label]) =>
      '<div class="lang-opt' + (LANG === id ? " active" : "") + '" onclick="setLang(\'' + id + "')\">" +
      "<span>" + label + "</span>" + (LANG === id ? "<span>✓</span>" : "") + "</div>"
    ).join("") + "</div></div>" +
    '<div class="card"><h3>📍 ' + esc(t("savedContact")) + "</h3>" +
    '<div class="field"><label>' + esc(t("deliveryAddress")) + '</label><input id="s-addr" value="' + esc(getPref("addr", "")) + '"></div>' +
    '<div class="field"><label>' + esc(t("deliveryPhone")) + '</label><input id="s-phone" value="' + esc(getPref("phone", "")) + '"></div>' +
    '<button class="btn" style="width:100%" onclick="savePrefs()">' + esc(t("save")) + "</button></div>" +
    '<div class="card"><h3>🔔 ' + esc(t("notifTitle")) + "</h3>" +
    '<div class="profile-row" style="align-items:center"><span>' + esc(t("notifDesc")) + "</span>" +
    '<label class="switch"><input type="checkbox" id="s-notif"' + (getPref("notif", "1") === "1" ? " checked" : "") + ' onchange="toggleNotif()"><span class="slider"></span></label></div></div>';
}
function savePrefs() {
  setPref("addr", (document.getElementById("s-addr").value || "").trim());
  setPref("phone", (document.getElementById("s-phone").value || "").trim());
  toast("✅");
}
function toggleNotif() {
  setPref("notif", document.getElementById("s-notif").checked ? "1" : "0");
}
/* Help: short trilingual FAQ. */
function viewHelp() {
  const app = document.getElementById("app");
  app.innerHTML =
    '<div class="card"><h2>❓ ' + esc(t("helpTitle")) + "</h2>" +
    "<h3>" + esc(t("helpQ1")) + "</h3><p>" + esc(t("helpA1")) + "</p>" +
    "<h3>" + esc(t("helpQ2")) + "</h3><p>" + esc(t("helpA2")) + "</p>" +
    "<h3>" + esc(t("helpQ3")) + "</h3><p>" + esc(t("helpA3")) + "</p></div>";
}
/* Contact Us: business phone as a tappable tel: link. */
function viewContact() {
  const app = document.getElementById("app");
  app.innerHTML =
    '<div class="card center"><h2>📞 ' + esc(t("contactUs")) + "</h2>" +
    '<div class="muted">' + esc(t("contactPhone")) + "</div>" +
    '<div style="font-size:24px;font-weight:800;margin:10px 0">' +
    '<a href="tel:09760967318">09760967318</a></div>' +
    '<a class="btn" href="tel:09760967318">📞 ' + esc(t("callNow")) + "</a></div>";
}

/* ---------- home: ONE BIG UNIFIED MENU (all dishes, all shops mixed) ---------- */
async function viewHome() {
  const app = document.getElementById("app");
  app.innerHTML =
    '<div class="card center"><h2 style="margin:0">🍜 ' + esc(t("appName")) + "</h2>" +
    '<div class="muted">' + esc(t("tagline")) + "</div></div>" +
    '<div class="toolbar"><input type="search" id="q" placeholder="' + esc(t("searchDishes")) +
      '" value="' + esc(homeFilter.q) + '"></div>' +
    '<div class="chips" id="chips"></div>' +
    '<h3 style="margin:4px 0 8px">🍽 ' + esc(t("unifiedMenu")) + '</h3><div class="dish-grid" id="dishGrid"></div>' +
    '<div id="feedSection"></div>';
  const chips = document.getElementById("chips");
  chips.innerHTML = CATEGORIES.map(c =>
    '<div class="chip' + (homeFilter.cat === c.id ? " active" : "") + '" data-cat="' + c.id + '">' +
    esc(catName(c.id)) + "</div>").join("");
  chips.querySelectorAll(".chip").forEach(ch =>
    ch.onclick = () => { homeFilter.cat = ch.getAttribute("data-cat"); viewHome(); });
  document.getElementById("q").oninput = (e) => { homeFilter.q = e.target.value; drawDishGrid(); };
  try {
    // one query: shops + their menus (public read, no login needed)
    const { data: shops, error } = await sb.from("shops").select("*, menu_items(*)");
    window._shops = [];
    window._dishIndex = {};
    window._allDishes = [];
    if (!error && shops) {
      for (const rs of shops) {
        const s = mapShop(rs);
        window._shops.push(s);
        for (const rm of (rs.menu_items || [])) {
          const it = mapItem(rm);
          if (it.available === false) continue;
          regDish(s.id, s, it);
          window._allDishes.push(window._dishIndex[s.id + "__" + it.id]);
        }
      }
    }
  } catch (e) { window._allDishes = []; }
  drawDishGrid();
  drawFeed();
  renderCartBar();
}
/* Register a menu item into the global dish index (used by home grid + cart).
 * Category comes from the ITEM first (a shop can sell across categories),
 * falling back to the shop's category. */
function regDish(shopId, shop, item) {
  window._dishIndex = window._dishIndex || {};
  const key = shopId + "__" + item.id;
  window._dishIndex[key] = {
    key: key, shopId: shopId, itemId: item.id,
    name_zh: item.name_zh, name_my: item.name_my, name_en: item.name_en,
    price: Number(item.price) || 0,
    photoUrl: item.photoUrl || "",
    category: item.category || shop.category || "all",
    emoji: item.emoji || shop.emoji || "🍜",
    shop_zh: shop.name_zh || "", shop_my: shop.name_my || shop.name_zh || "",
    shop_en: shop.name_en || shop.name_zh || ""
  };
}
/* Register a vendor post as an orderable pseudo-dish (key: shopId__post_<id>),
 * so post cards can use the same cart flow as dishes. */
function regPost(shopId, shop, post) {
  window._dishIndex = window._dishIndex || {};
  const key = shopId + "__post_" + post.id;
  window._dishIndex[key] = {
    key: key, shopId: shopId, itemId: "post_" + post.id,
    name_zh: post.body, name_my: post.body, name_en: post.body,
    price: Number(post.price) || 0,
    photoUrl: post.photoUrl || "", category: "all", emoji: "📢",
    shop_zh: (shop && shop.name_zh) || "",
    shop_my: (shop && (shop.name_my || shop.name_zh)) || "",
    shop_en: (shop && (shop.name_en || shop.name_zh)) || ""
  };
}
/* PLACEHOLDER: dish photos are decorative placeholders for now.
 * Real shops will upload real food photos later — set the `photo_url` field on
 * the menu item row and this helper will render <img src="photo_url">. */
function dishPhotoHTML(d) {
  if (d.photoUrl) {
    return '<div class="dish-photo"><img src="' + esc(d.photoUrl) + '" alt="" loading="lazy"></div>';
  }
  return '<div class="dish-photo ph ph-' + esc(d.category || "all") + '"><span>' + esc(d.emoji || "🍜") + "</span></div>";
}
function drawDishGrid() {
  const box = document.getElementById("dishGrid");
  if (!box) return;
  const q = (homeFilter.q || "").toLowerCase();
  const list = (window._allDishes || []).filter(d => {
    if (homeFilter.cat !== "all" && d.category !== homeFilter.cat) return false;
    if (!q) return true;
    return ((d.name_zh || "") + " " + (d.name_my || "") + " " + (d.shop_zh || "") + " " + (d.shop_my || "")).toLowerCase().includes(q);
  });
  const favs = getFavs();
  list.sort((a, b) => ((favs.indexOf(b.key) >= 0) ? 1 : 0) - ((favs.indexOf(a.key) >= 0) ? 1 : 0));
  if (!list.length) { box.innerHTML = '<div class="card center muted">' + esc(t("noDishes")) + "</div>"; return; }
  box.innerHTML = list.map(d => {
    const inCart = cart.items[d.key] ? cart.items[d.key].qty : 0;
    const nm = itemName(d);
    const nm2 = LANG === "zh" ? (d.name_my || "") : (d.name_zh || "");
    const shopLabel = LANG === "en" ? (d.shop_en || d.shop_zh) : (LANG === "my" ? (d.shop_my || d.shop_zh) : d.shop_zh);
    return '<div class="dish-card"><div class="dish-photo-wrap">' + dishPhotoHTML(d) +
      '<button class="fav-star' + (isFav(d.key) ? ' on' : '') + '" onclick="toggleFav(\'' + d.key + '\')">' + (isFav(d.key) ? '\u2605' : '\u2606') + '</button></div>' +
      '<div class="dish-body">' +
      '<div class="dish-name">' + esc(nm) + "</div>" +
      (nm2 ? '<div class="dish-name2">' + esc(nm2) + "</div>" : "") +
      '<div class="dish-shop" onclick="location.hash=\'#/shop/' + d.shopId + "'\">🏪 " + esc(shopLabel) + "</div>" +
      '<div data-rp="' + d.itemId + '"></div>' +
      '<div class="dish-foot"><div class="dish-price">' + money(d.price) + "</div>" +
      (inCart > 0
        ? '<div class="qty-ctrl"><button onclick="dishOrder(\'' + d.key + "',-1)\">−</button><b>" + inCart + "</b>" +
          '<button onclick="dishOrder(\'' + d.key + "',1)\">＋</button></div>"
        : '<button class="btn small" onclick="dishOrder(\'' + d.key + "',1)\">" + esc(t("order")) + "</button>") +
      "</div></div></div>";
  }).join("");
  loadRateBadges(box);
}
/* ---------- vendor posts feed (homepage + shop page) ----------
 * Post cards are compact like dish cards and orderable: tapping the order
 * button adds the post to the cart as a pseudo-dish. */
function postCardHTML(p, showShop) {
  const key = p.shopId + "__post_" + p.id;
  const inCart = cart.items[key] ? cart.items[key].qty : 0;
  const click = showShop ? ' onclick="location.hash=\'#/shop/' + p.shopId + "'\"" : "";
  const shopLabel = (showShop && p.shopName)
    ? '<div class="post-shop" onclick="event.stopPropagation();location.hash=\'#/shop/' + p.shopId + "'\">🏪 " + esc(p.shopName) + "</div>" : "";
  return '<div class="post-card"' + click + ">" +
    '<div class="post-photo" style="position:relative">' + (p.photoUrl ? '<img src="' + esc(p.photoUrl) + '" alt="" loading="lazy">' : "📢") +
    '<button class="fav-star' + (isFav(key) ? ' on' : '') + '" onclick="event.stopPropagation();toggleFav(\'' + key + '\')">' + (isFav(key) ? '\u2605' : '\u2606') + '</button></div>' +
    '<div class="post-body">' +
    '<div class="post-text">' + esc(p.body) + "</div>" +
    shopLabel +
    '<div class="post-foot"><span class="dish-price">' + money(p.price) + "</span>" +
    (inCart > 0
      ? '<div class="qty-ctrl"><button onclick="event.stopPropagation();postOrder(\'' + key + "',-1)\">−</button><b>" + inCart + "</b>" +
        '<button onclick="event.stopPropagation();postOrder(\'' + key + "',1)\">＋</button></div>"
      : '<button class="btn small" onclick="event.stopPropagation();postOrder(\'' + key + "',1)\">" + esc(t("order")) + "</button>") +
    "</div>" +
    '<div class="post-time">🏷️ ' + esc(catName(p.category || "foods")) + " · " + esc(fmtTime(p.createdAt)) + "</div>" +
    "</div></div>";
}
/* Homepage feed: newest posts across ALL shops (after the product grid). */
async function drawFeed() {
  const box = document.getElementById("feedSection");
  if (!box) return;
  try {
    const { data, error } = await sb.from("posts")
      .select("*, shops(name_zh, name_my, name_en)")
      .order("created_at", { ascending: false }).limit(10);
    if (error) throw error;
    const list = (data || []).map(r => {
      const p = mapPost(r);
      if (r.shops) { p.shopName = shopName(r.shops); regPost(p.shopId, r.shops, p); }
      return p;
    });
    window._feedPosts = list;
    renderFeedPosts();
  } catch (e) {
    // Hide silently (e.g. migrate-v3.sql not run yet) — never break the homepage.
    box.innerHTML = "";
  }
}
function renderFeedPosts() {
  const box = document.getElementById("feedSection");
  if (!box) return;
  const cat = (typeof homeFilter !== "undefined" && homeFilter.cat) || "all";
  const list = (window._feedPosts || []).filter(p => cat === "all" || (p.category || "foods") === cat);
  const favs = getFavs();
  list.sort((a, b) => ((favs.indexOf(b.shopId + "__post_" + b.id) >= 0) ? 1 : 0) - ((favs.indexOf(a.shopId + "__post_" + a.id) >= 0) ? 1 : 0));
  if (!list.length) { box.innerHTML = ""; return; }
  box.innerHTML = '<h3 style="margin:16px 0 8px">🔥 ' + esc(t("feedTitle")) + "</h3>" +
    '<div class="post-grid">' + list.map(p => postCardHTML(p, true)).join("") + "</div>";
}
/* Shop page: all posts by this shop, under the shop info. */
async function drawShopPosts(shopId) {
  const box = document.getElementById("shopPosts");
  if (!box) return;
  try {
    const { data, error } = await sb.from("posts").select("*")
      .eq("shop_id", shopId).order("created_at", { ascending: false });
    if (error) throw error;
    const list = (data || []).map(mapPost);
    const shop = shopCache[shopId] || { name_zh: "", name_my: "", name_en: "" };
    list.forEach(p => regPost(shopId, shop, p));
    window._shopPostsList = list;
    renderShopPosts();
  } catch (e) { box.innerHTML = ""; }
}
function renderShopPosts() {
  const box = document.getElementById("shopPosts");
  if (!box) return;
  const list = window._shopPostsList || [];
  if (!list.length) { box.innerHTML = ""; return; }
  box.innerHTML = '<h3 style="margin:12px 0 8px">📢 ' + esc(t("posts")) + "</h3>" +
    '<div class="post-grid">' + list.map(p => postCardHTML(p, false)).join("") + "</div>";
}
/* Add/remove a dish from the unified menu grid (multi-shop cart). */
function dishOrder(key, delta) {
  const d = (window._dishIndex || {})[key];
  if (!d) return;
  const y = window.scrollY;
  const cur = cart.items[key];
  const qty = (cur ? cur.qty : 0) + delta;
  if (qty <= 0) delete cart.items[key];
  else cart.items[key] = {
    shopId: d.shopId, itemId: d.itemId, qty: qty,
    name_zh: d.name_zh, name_my: d.name_my, name_en: d.name_en, price: d.price,
    photoUrl: d.photoUrl, emoji: d.emoji, shop_zh: d.shop_zh, shop_my: d.shop_my, shop_en: d.shop_en
  };
  drawDishGrid();
  renderCartBar();
  window.scrollTo(0, y);
}
/* Add/remove a vendor-post item to the cart (re-renders the post feeds). */
function postOrder(key, delta) {
  const d = (window._dishIndex || {})[key];
  if (!d) return;
  const y = window.scrollY;
  const cur = cart.items[key];
  const qty = (cur ? cur.qty : 0) + delta;
  if (qty <= 0) delete cart.items[key];
  else cart.items[key] = {
    shopId: d.shopId, itemId: d.itemId, qty: qty,
    name_zh: d.name_zh, name_my: d.name_my, name_en: d.name_en, price: d.price,
    photoUrl: d.photoUrl, emoji: d.emoji, shop_zh: d.shop_zh, shop_my: d.shop_my, shop_en: d.shop_en
  };
  renderFeedPosts();
  renderShopPosts();
  renderCartBar();
  window.scrollTo(0, y);
}

/* ---------- shop detail ---------- */
let shopCache = {};
async function viewShop(id) {
  const app = document.getElementById("app");
  app.innerHTML = '<div class="center muted" style="padding:30px">…</div>';
  let s;
  try {
    const { data, error } = await sb.from("shops").select("*").eq("id", id).single();
    if (error || !data) { app.innerHTML = '<div class="card">' + esc(t("noShops")) + "</div>"; return; }
    s = mapShop(data);
    shopCache[id] = s;
  } catch (e) { app.innerHTML = '<div class="card">⚠️ ' + esc(e.message) + "</div>"; return; }
  const addr = LANG === "zh" ? (s.address_zh || "") : (s.address_my || s.address_zh || "");
  app.innerHTML =
    '<p><a href="#/">' + esc(t("backToShops")) + "</a></p>" +
    '<div class="card"><h2 style="display:flex;align-items:center;gap:10px">' +
    (s.photo_url
      ? '<img src="' + esc(s.photo_url) + '" alt="" style="width:46px;height:46px;object-fit:cover;border-radius:50%;flex-shrink:0">'
      : esc(s.emoji || "🍜")) +
    "<span>" + esc(shopName(s)) +
    (s.sample ? '<span class="badge">' + esc(t("sampleBadge")) + "</span>" : "") + "</span></h2>" +
    '<div class="profile-row"><span class="k">' + esc(t("ownerName")) + "</span><span>" + esc(s.ownerName || "-") + "</span></div>" +
    '<div class="profile-row"><span class="k">' + esc(t("address")) + "</span><span>" + esc(addr) + "</span></div>" +
    '<div class="profile-row"><span class="k">' + esc(t("phone")) + "</span><span><a href=\"tel:" + esc(s.phone || "") + "\">" + esc(s.phone || "-") + "</a></span></div>" +
    (s.wechatId ? '<div class="profile-row"><span class="k">' + esc(t("wechatId")) + '</span><span class="copyable">' + esc(s.wechatId) + "</span></div>" : "") +
    (s.deliveryFee > 0 ? '<div class="profile-row"><span class="k">🛵 ' + esc(t("deliveryFee")) + "</span><span>" + money(s.deliveryFee) + "</span></div>" : "") +
    "</div>" +
    '<div id="shopPosts"></div>' +
    '<div class="tabs">' +
    '<div class="tab' + (shopTab === "menu" ? " active" : "") + '" onclick="setShopTab(\'' + id + "','menu')\">🍜 " + esc(t("menu")) + "</div>" +
    '<div class="tab' + (shopTab === "chat" ? " active" : "") + '" onclick="setShopTab(\'' + id + "','chat')\">💬 " + esc(t("chat")) + "</div>" +
    "</div><div id=\"shopTabBody\"></div>";
  if (shopTab === "menu") drawMenuTab(id, s); else drawChatTab(id, s);
  drawShopPosts(id);
}
function setShopTab(id, tab) { shopTab = tab; viewShop(id); }

async function drawMenuTab(id, s) {
  const body = document.getElementById("shopTabBody");
  body.innerHTML = '<div class="center muted">…</div>';
  let items = [];
  try {
    const { data, error } = await sb.from("menu_items").select("*").eq("shop_id", id).order("created_at");
    if (error) throw error;
    items = (data || []).map(mapItem).filter(x => x.available !== false);
  } catch (e) { body.innerHTML = "⚠️ " + esc(e.message); return; }
  items.forEach(it => regDish(id, s, it));
  body.innerHTML = '<div class="card">' + items.map(it => {
    const key = id + "__" + it.id;
    const inCart = cart.items[key] ? cart.items[key].qty : 0;
    return '<div class="menu-item"><div class="info"><div class="nm">' + esc(itemName(it)) + ' <span data-rp="' + it.id + '"></span></div>' +
      '<div class="pr">' + money(it.price) + "</div></div>" +
      '<div class="qty-ctrl">' +
      (inCart > 0 ? '<button onclick="cartQty(\'' + id + "','" + it.id + "',-1)\">−</button><b>" + inCart + "</b>" : "") +
      '<button onclick="cartQty(\'' + id + "','" + it.id + "',1)\">＋</button>" +
      "</div></div>";
  }).join("") + "</div>";
  renderCartBar();
  loadRateBadges(body);
}
function cartQty(shopId, itemId, delta) {
  const key = shopId + "__" + itemId;
  const d = (window._dishIndex || {})[key];
  if (!d) return;
  const cur = cart.items[key];
  const qty = (cur ? cur.qty : 0) + delta;
  if (qty <= 0) delete cart.items[key];
  else cart.items[key] = {
    shopId: d.shopId, itemId: d.itemId, qty: qty,
    name_zh: d.name_zh, name_my: d.name_my, name_en: d.name_en, price: d.price,
    photoUrl: d.photoUrl, emoji: d.emoji, shop_zh: d.shop_zh, shop_my: d.shop_my, shop_en: d.shop_en
  };
  const s = shopCache[shopId];
  drawMenuTab(shopId, s);
  renderCartBar();
}
/* Global cart bar (cart may hold items from multiple shops). */
function renderCartBar() {
  renderTapbar();
  const bar = document.getElementById("cartbar");
  if (!bar) return;
  if (!cartCount()) { bar.innerHTML = ""; return; }
  bar.innerHTML =
    '<div class="cartbar"><div class="tot">🛒 ' + cartCount() + " · " + money(cartTotal()) + "</div>" +
    '<div style="flex:1"></div>' +
    '<button class="btn" onclick="location.hash=\'#/cart\'">' + esc(t("viewCart")) + "</button></div>";
}

/* ---------- cart view + checkout (one order per shop) ---------- */
let cartFees = {}; // shopId -> delivery fee, refreshed by viewCart()
async function shopFee(sid) {
  if (cartFees[sid] != null) return cartFees[sid];
  let fee = 0;
  try {
    const { data } = await sb.from("shops").select("delivery_fee_yuan").eq("id", sid).single();
    if (data) fee = Number(data.delivery_fee_yuan) || 0;
  } catch (e) {}
  cartFees[sid] = fee;
  return fee;
}
function cartFeesTotal() {
  return Object.values(cartFees).reduce((a, f) => a + (Number(f) || 0), 0);
}
function cartGrandTotal() { return cartTotal() + cartFeesTotal(); }
async function viewCart() {
  const app = document.getElementById("app");
  const entries = Object.entries(cart.items);
  if (!entries.length) {
    app.innerHTML = '<p><a href="#/">' + esc(t("backToMenu")) + "</a></p>" +
      '<div class="card center muted">' + esc(t("emptyCart")) + "</div>";
    return;
  }
  const groups = {};
  entries.forEach(([key, it]) => { (groups[it.shopId] = groups[it.shopId] || []).push(Object.assign({ key: key }, it)); });
  cartFees = {};
  for (const sid of Object.keys(groups)) await shopFee(sid);
  let html = '<p><a href="#/">' + esc(t("backToMenu")) + "</a></p>" +
    "<h2>🛒 " + esc(t("cart")) + " (" + cartCount() + ")</h2>";
  for (const sid of Object.keys(groups)) {
    const g = groups[sid];
    const fee = cartFees[sid] || 0;
    const shopLabel = LANG === "en" ? (g[0].shop_en || g[0].shop_zh) : (LANG === "my" ? (g[0].shop_my || g[0].shop_zh) : g[0].shop_zh);
    html += '<div class="card"><h3>🏪 ' + esc(shopLabel) + "</h3>" + g.map(it => {
      const nm = itemName(it);
      return '<div class="menu-item"><div class="info"><div class="nm">' + esc(nm) + "</div>" +
        '<div class="pr">' + money(it.price) + "</div></div>" +
        '<div class="qty-ctrl"><button onclick="cartViewDelta(\'' + it.key + "',-1)\">−</button><b>" + it.qty + "</b>" +
        '<button onclick="cartViewDelta(\'' + it.key + "',1)\">＋</button></div></div>";
    }).join("") +
    (fee > 0 ? '<div class="profile-row"><span>🛵 ' + esc(t("deliveryFee")) + "</span><b>" + money(fee) + "</b></div>" : "") +
    "</div>";
  }
  html += '<div class="card"><h3>📍 ' + esc(t("deliveryAddress")) + "</h3>" +
    '<div class="field"><label>' + esc(t("deliveryAddress")) + '</label><input id="co-addr" value="' + esc(getPref("addr", "")) + '"></div>' +
    '<div class="field"><label>' + esc(t("deliveryPhone")) + '</label><input id="co-phone" value="' + esc((userDoc && userDoc.phone) || getPref("phone", "")) + '"></div>' +
    '<div class="field"><label>' + esc(t("orderNote")) + '</label><input id="co-note" placeholder="' + esc(t("notePlaceholder")) + '"></div></div>';
  html += '<div class="card">' +
    '<div class="profile-row"><span>' + esc(t("subtotal")) + "</span><b>" + money(cartTotal()) + "</b></div>" +
    '<div class="profile-row"><span>🛵 ' + esc(t("deliveryFee")) + "</span><b>" + money(cartFeesTotal()) + "</b></div>" +
    '<div class="profile-row"><span>' + esc(t("total")) + "</span><b>" + money(cartGrandTotal()) + "</b></div>" +
    '<button class="btn" style="width:100%;margin-top:8px" onclick="checkoutAll()">' + esc(t("buyNow")) + "</button></div>";
  app.innerHTML = html;
}
function cartViewDelta(key, delta) {
  const cur = cart.items[key];
  if (!cur) return;
  // preserve checkout fields across the re-render
  const addrEl = document.getElementById("co-addr");
  const saved = addrEl ? {
    a: addrEl.value,
    p: document.getElementById("co-phone").value,
    n: document.getElementById("co-note").value
  } : null;
  cur.qty += delta;
  if (cur.qty <= 0) delete cart.items[key];
  viewCart().then(() => {
    if (saved) {
      const a2 = document.getElementById("co-addr");
      if (a2) {
        a2.value = saved.a;
        document.getElementById("co-phone").value = saved.p;
        document.getElementById("co-note").value = saved.n;
      }
    }
  });
}
async function checkoutAll() {
  if (needLogin()) return;
  const groups = {};
  Object.values(cart.items).forEach(it => { (groups[it.shopId] = groups[it.shopId] || []).push(it); });
  const shopIds = Object.keys(groups);
  if (!shopIds.length) return;
  const addr = (document.getElementById("co-addr").value || "").trim();
  const phone = (document.getElementById("co-phone").value || "").trim();
  const note = (document.getElementById("co-note").value || "").trim();
  if (!addr || !phone) { toast("⚠️ " + t("fillAddressPhone")); return; }
  if (!(await confirmDlg(t("confirmOrder") + " · " + money(cartGrandTotal())))) return;
  try {
    for (const sid of shopIds) {
      const items = groups[sid].map(it => ({
        itemId: it.itemId, name_zh: it.name_zh, name_my: it.name_my, name_en: it.name_en,
        price: it.price, qty: it.qty
      }));
      await placeShopOrder(sid, items, { address: addr, phone: phone, note: note });
    }
    cart = { items: {} };
    cartFees = {};
    toast("✅ " + t("orderSent"));
    location.hash = "#/orders";
  } catch (e) { toast("⚠️ " + e.message); }
}
/* Create one order + drop the item list as a message into the vendor's chatbox. */
async function placeShopOrder(shopId, items, delivery) {
  let s = shopCache[shopId];
  if (!s) {
    const { data, error } = await sb.from("shops").select("*").eq("id", shopId).single();
    if (error || !data) throw new Error("shop not found");
    s = mapShop(data);
    shopCache[shopId] = s;
  }
  const fee = await shopFee(shopId);
  const subtotal = items.reduce((a, it) => a + it.qty * it.price, 0);
  const total = subtotal + fee;
  const { data: order, error: oErr } = await sb.from("orders").insert({
    shop_id: shopId,
    customer_id: currentUser.id,
    vendor_id: s.ownerUid,
    // denormalized so the vendor can show who ordered without reading
    // the customer's private user row (RLS forbids it)
    customer_name: (userDoc && userDoc.name) || currentUser.email,
    customer_email: currentUser.email || "",
    items: items, total_yuan: total,
    delivery_address: delivery.address, customer_phone: delivery.phone,
    note: delivery.note || null, delivery_fee_yuan: fee,
    status: "pending", conversation_id: null
  }).select().single();
  if (oErr) throw oErr;
  const convId = await ensureConversation(shopId, s.ownerUid);
  await sb.from("orders").update({ conversation_id: convId }).eq("id", order.id);
  const deliveryInfo = "📍 " + delivery.address + "\n📞 " + delivery.phone +
    (delivery.note ? "\n📝 " + delivery.note : "");
  await sb.from("messages").insert({
    conversation_id: convId, sender_id: currentUser.id, sender_role: "customer",
    kind: "order", order_id: order.id, items: items, total_yuan: total,
    body: deliveryInfo
  });
  await sb.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", convId);
}
/* One conversation per customer × shop (UNIQUE(shop_id, customer_id)). */
async function ensureConversation(shopId, vendorUid) {
  const { data: existing } = await sb.from("conversations")
    .select("id").eq("shop_id", shopId).eq("customer_id", currentUser.id).single();
  if (existing) return existing.id;
  const { data, error } = await sb.from("conversations").insert({
    shop_id: shopId, customer_id: currentUser.id, vendor_id: vendorUid,
    // denormalized so the vendor can show the customer name without
    // reading the customer's private user row (RLS forbids it)
    customer_name: (userDoc && userDoc.name) || currentUser.email,
    last_message_at: new Date().toISOString()
  }).select("id").single();
  if (error) throw error;
  return data.id;
}

/* ---------- chat (shared by customer & vendor) ---------- */
async function drawChatTab(shopId, shop) {
  const body = document.getElementById("shopTabBody");
  if (needLogin()) return;
  body.innerHTML = '<div class="card"><div class="center muted">…</div></div>';
  const convId = await ensureConversation(shopId, shop.ownerUid);
  mountChat(body, convId, shopName(shop));
}
/* unread badges: per-conversation counts of messages from the other side
 * newer than the viewer's last-read timestamp. */
async function unreadCounts(convIds, readKey, convById) {
  const counts = {};
  const ids = (convIds || []).filter(Boolean);
  if (!ids.length || !currentUser) return counts;
  try {
    const { data, error } = await sb.from("messages")
      .select("conversation_id,created_at,sender_id")
      .in("conversation_id", ids)
      .neq("sender_id", currentUser.id)
      .order("created_at", { ascending: false })
      .limit(300);
    if (error || !data) return counts;
    for (const m of data) {
      const c = convById[m.conversation_id] || {};
      const readAt = c[readKey] || null;
      if (!readAt || new Date(m.created_at) > new Date(readAt))
        counts[m.conversation_id] = (counts[m.conversation_id] || 0) + 1;
    }
  } catch (e) {}
  return counts;
}
async function markChatRead(convId) {
  try {
    if (!currentUser) return;
    // Decide the column from the conversation row itself (robust even if
    // the cached userDoc role is stale or missing).
    const { data: conv } = await sb.from("conversations")
      .select("customer_id,vendor_id").eq("id", convId).single();
    if (!conv) return;
    const col = (conv.vendor_id && conv.vendor_id === currentUser.id)
      ? "vendor_last_read_at" : "customer_last_read_at";
    const patch = {}; patch[col] = new Date().toISOString();
    await sb.from("conversations").update(patch).eq("id", convId);
  } catch (e) {}
}
async function mountChat(container, convId, title) {
  container.innerHTML =
    '<div class="card"><h3>💬 ' + esc(title || "") + "</h3>" +
    '<div class="chatbox"><div class="msgs"></div>' +
    '<div class="chat-input">' +
    '<button class="icon-btn chat-attach">📎</button>' +
    '<input class="chat-file" type="file" accept="image/*,video/*" style="display:none">' +
    '<input class="chat-in" placeholder="' + esc(t("typeMessage")) + '">' +
    '<button class="send-btn chat-send">➤</button></div>' +
    "</div></div>";
  const box = container.querySelector(".msgs");
  const render = (rows) => {
    box.innerHTML = rows.map(m => {
      const me = m.senderUid === currentUser.id;
      let inner;
      if (m.type === "order") {
        const items = (m.items || []).map(it =>
          "<div>" + esc(itemName(it)) +
          " × " + it.qty + " · " + money(it.price * it.qty) + "</div>").join("");
        const dinfo = m.text
          ? '<div class="delivery-info">' + esc(m.text).replace(/\n/g, "<br>") + "</div>" : "";
        inner = '<div class="order-card msg ' + (me ? "me" : "them") + '">' +
          '<div class="otitle">🧾 ' + esc(t("orderItems")) + " · " + money(m.total) + "</div>" +
          items + dinfo + '<span class="time">' + esc(fmtTime(m.createdAt)) + "</span></div>";
      } else if (m.type === "image" && m.mediaUrl) {
        inner = '<div class="msg media ' + (me ? "me" : "them") + '">' +
          '<img src="' + esc(m.mediaUrl) + '" alt="" loading="lazy">' +
          '<span class="time">' + esc(fmtTime(m.createdAt)) + "</span></div>";
      } else if (m.type === "video" && m.mediaUrl) {
        inner = '<div class="msg media ' + (me ? "me" : "them") + '">' +
          '<video src="' + esc(m.mediaUrl) + '" controls playsinline preload="metadata"></video>' +
          '<span class="time">' + esc(fmtTime(m.createdAt)) + "</span></div>";
      } else {
        inner = '<div class="msg ' + (me ? "me" : "them") + '">' + esc(m.text || "") +
          '<span class="time">' + esc(fmtTime(m.createdAt)) + "</span></div></div>";
      }
      return inner;
    }).join("");
    box.scrollTop = box.scrollHeight;
  };
  const load = async () => {
    const { data, error } = await sb.from("messages")
      .select("*").eq("conversation_id", convId).order("created_at");
    if (error) { box.innerHTML = "⚠️ " + esc(error.message); return; }
    render((data || []).map(mapMsg));
  };
  await load();
  markChatRead(convId);
  // realtime: reload messages whenever a new one arrives in this conversation
  const ch = sb.channel("chat-" + convId)
    .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "messages", filter: "conversation_id=eq." + convId },
      (payload) => {
        load();
        markChatRead(convId);
        const m = payload && payload.new;
        if (m && m.sender_id !== currentUser.id) {
            const preview = m.kind === "image" ? "📷 " + t("photoSent")
              : m.kind === "video" ? "🎥 " + t("videoSent")
              : (m.body || "").slice(0, 40);
            notifyPing("💬 " + t("newMessage") + ": " + preview);
          }
      })
    .subscribe();
  unsubs.push(ch);
  const inp = container.querySelector(".chat-in");
  const fileInp = container.querySelector(".chat-file");
  inp.addEventListener("keydown", e => { if (e.key === "Enter") sendMsg(convId, inp); });
  container.querySelector(".chat-attach").onclick = () => fileInp.click();
  fileInp.onchange = () => sendMedia(convId, fileInp);
  container.querySelector(".chat-send").onclick = () => sendMsg(convId, inp);
}
async function sendMsg(convId, inp) {
  if (!inp) return;
  const text = (inp.value || "").trim();
  if (!text) return;
  inp.value = "";
  try {
    const { error } = await sb.from("messages").insert({
      conversation_id: convId, sender_id: currentUser.id,
      sender_role: (userDoc && userDoc.role) || "customer",
      kind: "text", body: text
    });
    if (error) throw error;
    await sb.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", convId);
  } catch (e) { toast("⚠️ " + e.message); }
}

async function sendMedia(convId, inp) {
  const file = inp && inp.files && inp.files[0];
  if (inp) inp.value = "";
  if (!file) return;
  const isImg = file.type.startsWith("image/");
  const isVid = file.type.startsWith("video/");
  if (!isImg && !isVid) { toast("\u26A0\uFE0F " + t("mediaOnly")); return; }
  if (file.size > 20 * 1024 * 1024) { toast("\u26A0\uFE0F " + t("mediaTooBig")); return; }
  try {
    toast("\u23F3 " + t("uploadingPhoto"));
    const ext = ((file.name.split(".").pop() || (isImg ? "jpg" : "mp4")).toLowerCase().replace(/[^a-z0-9]/g, "")) || (isImg ? "jpg" : "mp4");
    const path = convId + "/" + Date.now() + "." + ext;
    const { error: upErr } = await sb.storage.from("chat-media").upload(path, file, { contentType: file.type });
    if (upErr) throw upErr;
    const url = sb.storage.from("chat-media").getPublicUrl(path).data.publicUrl;
    const { error } = await sb.from("messages").insert({
      conversation_id: convId, sender_id: currentUser.id,
      sender_role: (userDoc && userDoc.role) || "customer",
      kind: isImg ? "image" : "video", body: "", media_url: url
    });
    if (error) throw error;
    await sb.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", convId);
  } catch (e) { toast("\u26A0\uFE0F " + e.message); }
}

/* ---------- ratings & reviews ---------- */
window._rateAvg = {};
window._rateFetched = new Set();
/* Fill every [data-rp=productId] badge with the average stars (cached). */
async function loadRateBadges(root) {
  const scope = root || document;
  const els = [...scope.querySelectorAll("[data-rp]")];
  if (!els.length) return;
  const ids = [...new Set(els.map(e => e.getAttribute("data-rp")))]
    .filter(id => id && /^[0-9a-f-]{36}$/i.test(id) && !window._rateFetched.has(id));
  if (ids.length) {
    try {
      const { data } = await sb.from("ratings").select("product_id,stars").in("product_id", ids);
      const agg = {};
      (data || []).forEach(r => {
        const a = agg[r.product_id] || (agg[r.product_id] = { s: 0, n: 0 });
        a.s += r.stars; a.n++;
      });
      ids.forEach(id => {
        window._rateFetched.add(id);
        const a = agg[id];
        window._rateAvg[id] = a ? { avg: a.s / a.n, count: a.n } : { avg: 0, count: 0 };
      });
    } catch (e) {}
  }
  els.forEach(e => {
    const id = e.getAttribute("data-rp");
    const r = window._rateAvg[id];
    if (r && r.count > 0) {
      e.innerHTML = '<span class="rate-pill">\u2605 ' + r.avg.toFixed(1) + " (" + r.count + ")</span>";
      e.querySelector(".rate-pill").onclick = (ev) => { ev.stopPropagation(); showReviews(id); };
    } else e.innerHTML = "";
  });
}
/* Popup with recent comments for a product. */
async function showReviews(productId) {
  const m = document.createElement("div");
  m.className = "modal-ov";
  m.innerHTML = '<div class="modal"><h3>\u2B50 ' + esc(t("reviews")) + '</h3><div class="center muted">\u2026</div></div>';
  document.body.appendChild(m);
  m.onclick = (e) => { if (e.target === m) m.remove(); };
  try {
    const { data } = await sb.from("ratings").select("*").eq("product_id", productId)
      .order("created_at", { ascending: false }).limit(30);
    const list = data || [];
    m.querySelector(".modal").innerHTML =
      '<h3>\u2B50 ' + esc(t("reviews")) + ' <button class="btn small gray" id="rv-x" style="float:right">\u2715</button></h3>' +
      (list.length ? list.map(r =>
        '<div class="review"><div>' + "\u2605".repeat(r.stars) + "\u2606".repeat(5 - r.stars) +
        ' <b>' + esc(r.customer_name || "") + "</b></div>" +
        (r.comment ? "<div>" + esc(r.comment) + "</div>" : "") +
        '<div class="meta">' + esc(fmtTime(r.created_at)) + "</div></div>").join("")
        : '<div class="center muted">' + esc(t("noReviews")) + "</div>");
    m.querySelector("#rv-x").onclick = () => m.remove();
  } catch (e) {
    m.querySelector(".modal").innerHTML = "\u26A0\uFE0F " + esc(e.message);
  }
}
/* Rate every item of a completed order (stars + one comment). */
function rateSheet(orderId) {
  const o = (window._orderList || {})[orderId];
  if (!o || !o.items || !o.items.length || needLogin()) return;
  const m = document.createElement("div");
  m.className = "modal-ov";
  const rows = o.items.map((it, i) =>
    '<div class="rate-row" data-i="' + i + '"><div style="flex:1">' + esc(itemName(it)) + "</div>" +
    '<div class="stars">' + [1, 2, 3, 4, 5].map(n => '<span data-s="' + n + '">\u2606</span>').join("") + "</div></div>").join("");
  m.innerHTML = '<div class="modal"><h3>\u2B50 ' + esc(t("rateOrder")) + "</h3>" + rows +
    '<div class="field" style="margin-top:8px"><label>' + esc(t("comment")) + '</label>' +
    '<textarea id="rate-comment" rows="2"></textarea></div>' +
    '<div class="rowbtns"><button class="btn" id="rate-save">' + esc(t("save")) + "</button>" +
    '<button class="btn gray" id="rate-cancel">' + esc(t("cancel")) + "</button></div></div>";
  document.body.appendChild(m);
  m.onclick = (e) => { if (e.target === m) m.remove(); };
  const sel = {};
  m.querySelectorAll(".rate-row").forEach(row => {
    const i = row.getAttribute("data-i");
    row.querySelectorAll(".stars span").forEach(sp => {
      sp.onclick = () => {
        sel[i] = Number(sp.getAttribute("data-s"));
        row.querySelectorAll(".stars span").forEach(x => {
          const on = Number(x.getAttribute("data-s")) <= sel[i];
          x.textContent = on ? "\u2605" : "\u2606";
          x.style.color = on ? "#ffb400" : "#ccc";
        });
      };
    });
  });
  m.querySelector("#rate-cancel").onclick = () => m.remove();
  m.querySelector("#rate-save").onclick = async () => {
    if (!Object.keys(sel).length) { toast("\u26A0\uFE0F"); return; }
    const comment = m.querySelector("#rate-comment").value.trim();
    const btn = m.querySelector("#rate-save");
    btn.disabled = true;
    try {
      for (const i of Object.keys(sel)) {
        const it = o.items[Number(i)];
        if (!it || !it.itemId || String(it.itemId).startsWith("post_")) continue;
        await sb.from("ratings").upsert({
          shop_id: o.shopId, product_id: it.itemId, customer_id: currentUser.id,
          customer_name: (userDoc && userDoc.name) || currentUser.email || "",
          stars: sel[i], comment: comment
        }, { onConflict: "product_id,customer_id" });
        window._rateFetched.delete(it.itemId);
      }
      toast("\u2705");
      m.remove();
      loadRateBadges(document);
    } catch (e) { toast("\u26A0\uFE0F " + e.message); btn.disabled = false; }
  };
}
/* One-tap reorder: put the order's items back into the cart (price/photo
 * refreshed from the live menu; unavailable items are skipped). */
async function reorder(orderId) {
  const o = (window._orderList || {})[orderId];
  if (!o || !o.items || !o.items.length || needLogin()) return;
  toast("\u23F3");
  try {
    const [menuRes, shopRes] = await Promise.all([
      sb.from("menu_items").select("*").eq("shop_id", o.shopId),
      sb.from("shops").select("*").eq("id", o.shopId).single()
    ]);
    const byId = {};
    (menuRes.data || []).forEach(x => byId[x.id] = x);
    const sh = shopRes.data ? mapShop(shopRes.data) : {};
    let added = 0, dropped = 0;
    for (const it of o.items) {
      const mid = String(it.itemId || "");
      const cur = (!mid.startsWith("post_")) ? byId[it.itemId] : null;
      if (!cur || cur.available === false) { dropped++; continue; }
      const key = o.shopId + "__" + it.itemId;
      const old = cart.items[key];
      cart.items[key] = {
        shopId: o.shopId, itemId: it.itemId, qty: (old ? old.qty : 0) + (it.qty || 1),
        name_zh: cur.name_zh, name_my: cur.name_my, name_en: cur.name_en,
        price: Number(cur.price_yuan) || 0, photoUrl: cur.photo_url, emoji: cur.emoji,
        shop_zh: sh.name_zh, shop_my: sh.name_my, shop_en: sh.name_en
      };
      added++;
    }
    renderCartBar();
    if (!added) { toast("\u26A0\uFE0F " + t("itemsDropped")); return; }
    if (dropped) toast(t("reordered") + " · " + t("itemsDropped"));
    else toast("\u2705 " + t("reordered"));
    location.hash = "#/cart";
  } catch (e) { toast("\u26A0\uFE0F " + e.message); }
}

/* ---------- customer orders ---------- */
async function viewOrders() {
  if (needLogin()) return;
  const app = document.getElementById("app");
  app.innerHTML = "<h2>📦 " + esc(t("orders")) + '</h2><div id="olist"><div class="center muted">…</div></div>';
  window._openOrderChat = null;
  try {
    const { data, error } = await sb.from("orders").select("*")
      .eq("customer_id", currentUser.id).order("created_at", { ascending: false });
    if (error) throw error;
    const list = (data || []).map(mapOrder);
    const box = document.getElementById("olist");
    if (!list.length) { box.innerHTML = '<div class="card center muted">' + esc(t("noOrders")) + "</div>"; return; }
    const shops = {};
    for (const o of list) {
      if (!shops[o.shopId]) {
        const { data: sd } = await sb.from("shops").select("*").eq("id", o.shopId).single();
        shops[o.shopId] = sd ? mapShop(sd) : {};
      }
    }
    window._orderChatInfo = {};
    window._convToOrder = {};
    window._orderList = {};
    const convIds = list.map(o => o.convId).filter(Boolean);
    let convById = {};
    if (convIds.length) {
      try {
        const { data: convs } = await sb.from("conversations").select("id,customer_last_read_at").in("id", convIds);
        (convs || []).forEach(c => convById[c.id] = { customerReadAt: c.customer_last_read_at });
      } catch (e) {}
    }
    window._unreadByConv = await unreadCounts(convIds, "customerReadAt", convById);
    box.innerHTML = list.map(o => {
      const sh = shops[o.shopId] || {};
      window._orderChatInfo[o.id] = { shopId: o.shopId, vendorUid: o.vendorUid, title: shopName(sh) };
      if (o.convId) window._convToOrder[o.convId] = o.id;
      window._orderList[o.id] = o;
      return orderCard(o, sh, false);
    }).join("");
    box.querySelectorAll("[data-reorder]").forEach(b => b.onclick = () => reorder(b.getAttribute("data-reorder")));
    box.querySelectorAll("[data-rateorder]").forEach(b => b.onclick = () => rateSheet(b.getAttribute("data-rateorder")));
      // realtime: vendor replies -> bump the chat badge live (ping unless its chatbox is open)
      if (convIds.length) {
        const mch = sb.channel("my-msgs-" + currentUser.id)
          .on("postgres_changes",
            { event: "INSERT", schema: "public", table: "messages", filter: "conversation_id=in.(" + convIds.join(",") + ")" },
            (payload) => {
              const m = payload && payload.new;
              if (!m || m.sender_id === currentUser.id) return;
              if (window._openOrderChat === m.conversation_id) return; // seen in open chatbox
              const cur = (((window._unreadByConv || {})[m.conversation_id] || 0) + 1);
              window._unreadByConv = window._unreadByConv || {};
              window._unreadByConv[m.conversation_id] = cur;
              const oid = (window._convToOrder || {})[m.conversation_id];
              if (oid) {
                const btn = document.querySelector('[data-chatbtn="' + oid + '"]');
                if (btn) {
                  let b = btn.querySelector(".ubadge");
                  if (!b) { b = document.createElement("span"); b.className = "ubadge"; btn.appendChild(b); }
                  b.textContent = cur;
                }
              }
              const preview = m.kind === "image" ? "📷 " + t("photoSent")
                : m.kind === "video" ? "🎥 " + t("videoSent")
                : (m.body || "").slice(0, 40);
              notifyPing("💬 " + t("newMessage") + ": " + preview);
            })
          .subscribe();
        unsubs.push(mch);
      }
  } catch (e) {
    document.getElementById("olist").innerHTML = "⚠️ " + esc(e.message);
  }
  // realtime: refresh the list whenever one of my orders changes status
  const ch = sb.channel("my-orders-" + currentUser.id)
    .on("postgres_changes",
      { event: "*", schema: "public", table: "orders", filter: "customer_id=eq." + currentUser.id },
      (payload) => {
        if (payload && payload.eventType === "UPDATE") notifyPing("📦 " + t("orderUpdated"));
        stopListeners(); viewOrders();
      })
    .subscribe();
  unsubs.push(ch);
}
async function toggleOrderChat(orderId) {
  if (needLogin()) return;
  const box = document.getElementById("oc-" + orderId);
  if (!box) return;
  if (box.dataset.open === "1") { box.innerHTML = ""; box.dataset.open = ""; window._openOrderChat = null; return; }
  const info = (window._orderChatInfo || {})[orderId];
  if (!info) return;
  box.dataset.open = "1";
  box.innerHTML = '<div class="card"><div class="center muted">\u2026</div></div>';
  try {
    const convId = await ensureConversation(info.shopId, info.vendorUid);
    window._openOrderChat = convId;
    if (window._unreadByConv) window._unreadByConv[convId] = 0;
    const badge = document.querySelector('[data-chatbtn="' + orderId + '"] .ubadge');
    if (badge) badge.remove();
    mountChat(box, convId, info.title);
  } catch (e) { box.innerHTML = '<div class="card">\u26A0\uFE0F ' + esc(e.message || e) + "</div>"; }
}
function orderCard(o, shop, isVendor) {
  const items = (o.items || []).map(it =>
    "<div>" + esc(itemName(it)) +
    " × " + it.qty + " · " + money(it.price * it.qty) + "</div>").join("");
  let btns = "";
  if (isVendor) {
    if (o.status === "pending") btns += '<button class="btn small green" onclick="setStatus(\'' + o.id + "','" + o.convId + "','accepted')\">" + esc(t("acceptOrder")) + "</button>";
    if (o.status === "accepted") btns += '<button class="btn small" onclick="setStatus(\'' + o.id + "','" + o.convId + "','delivering')\">" + esc(t("startDelivery")) + "</button>";
    if (o.status === "delivering") btns += '<button class="btn small green" onclick="setStatus(\'' + o.id + "','" + o.convId + "','done')\">" + esc(t("completeOrder")) + "</button>";
    if (o.status === "pending" || o.status === "accepted")
      btns += '<button class="btn small gray" onclick="setStatus(\'' + o.id + "','" + o.convId + "','cancelled')\">" + esc(t("cancelOrder")) + "</button>";
  } else {
    const uc = ((window._unreadByConv || {})[o.convId] || 0);
    btns += '<button class="btn small" data-chatbtn="' + o.id + '" onclick="toggleOrderChat(\'' + o.id + "')\">" + "💬 " + esc(t("chat")) + (uc ? ' <span class="ubadge">' + uc + "</span>" : "") + "</button>";
    if (o.status === "pending")
      btns += '<button class="btn small gray" onclick="cancelMyOrder(\'' + o.id + "')\">" + esc(t("cancelOrder")) + "</button>";
    btns += '<button class="btn small" data-reorder="' + o.id + '">🔁 ' + esc(t("reorder")) + "</button>";
    if (o.status === "done")
      btns += '<button class="btn small" data-rateorder="' + o.id + '">⭐ ' + esc(t("rateIt")) + "</button>";
  }
  return '<div class="card order-card2"><div style="display:flex;justify-content:space-between;align-items:center">' +
    "<b>" + esc(shop ? shopName(shop) : o.shopId) + "</b>" +
    '<span class="status ' + o.status + '">' + esc(t("status_" + o.status)) + "</span></div>" +
    '<div class="muted">' + esc(fmtTime(o.createdAt)) + "</div>" +
    '<div style="margin:6px 0">' + items + "</div>" +
    ((o.deliveryAddress || o.customerPhone)
      ? '<div class="delivery-info">📍 ' + esc(o.deliveryAddress || "") +
        (o.customerPhone ? "<br>📞 " + esc(o.customerPhone) : "") +
        (o.note ? "<br>📝 " + esc(o.note) : "") + "</div>" : "") +
    (o.deliveryFee > 0
      ? '<div class="profile-row"><span>🛵 ' + esc(t("deliveryFee")) + "</span><b>" + money(o.deliveryFee) + "</b></div>" : "") +
    "<b>" + esc(t("total")) + ": " + money(o.total) + "</b>" +
    (btns ? '<div class="rowbtns">' + btns + "</div>" : "") +
    (isVendor ? "" : '<div id="oc-' + o.id + '" style="margin-top:8px"></div>') + "</div>";
}
async function setStatus(orderId, convId, status) {
  try {
    const { error } = await sb.from("orders").update({ status: status }).eq("id", orderId);
    if (error) throw error;
    if (convId) {
      await sb.from("messages").insert({
        conversation_id: convId, sender_id: currentUser.id,
        sender_role: (userDoc && userDoc.role) || "vendor",
        kind: "text", body: "📦 " + t("status_" + status)
      });
    }
    renderAll();
  } catch (e) { toast("⚠️ " + e.message); }
}
async function cancelMyOrder(orderId) {
  if (!(await confirmDlg(t("cancelOrder") + "?"))) return;
  try {
    const { error } = await sb.from("orders").update({ status: "cancelled" }).eq("id", orderId);
    if (error) throw error;
    renderAll();
  } catch (e) { toast("⚠️ " + e.message); }
}

/* ---------- vendor dashboard ---------- */
let myShop = null;
async function viewVendor() {
  if (needLogin()) return;
  const app = document.getElementById("app");
  app.innerHTML = "<h2>🏪 " + esc(t("vendorCenter")) + '</h2><div id="vbody"><div class="center muted">…</div></div>';
  const body = document.getElementById("vbody");
  if (!userDoc || (userDoc.role !== "vendor" && userDoc.role !== "admin")) {
    body.innerHTML = '<div class="notice">⚠️ ' + esc(t("loginFirst")) + "</div>";
    return;
  }
  try {
    const { data, error } = await sb.from("shops").select("*").eq("owner_id", currentUser.id).limit(1);
    if (error) throw error;
    myShop = (data && data.length) ? mapShop(data[0]) : null;
  } catch (e) { body.innerHTML = "⚠️ " + esc(e.message); return; }
  if (!myShop) {
    body.innerHTML = '<div class="notice">' + esc(t("welcomeVendor")) + "</div>" + shopForm({});
    return;
  }
  const shopAddr = myShop.address_zh || myShop.address_my || "";
  body.innerHTML =
    '<div class="card" style="display:flex;gap:20px;position:relative">' +
    '<button class="btn small" style="position:absolute;top:8px;right:8px;padding:6px 10px" onclick="editShopInfo()">✏️</button>' +
    '<div style="position:relative;flex-shrink:0" onclick="document.getElementById(\'v-photo\').click()">' +
    (myShop.photo_url
      ? '<img src="' + esc(myShop.photo_url) + '" alt="" style="width:112px;height:112px;border-radius:50%;object-fit:cover;display:block">'
      : '<div style="width:112px;height:112px;border-radius:50%;background:#fce4ec;display:flex;align-items:center;justify-content:center;font-size:48px">🏪</div>') +
    '<div style="position:absolute;right:-2px;bottom:-2px;background:var(--pink);color:#fff;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:12px;border:2px solid #fff">📷</div></div>' +
    '<input id="v-photo" type="file" accept="image/*" style="display:none" onchange="uploadShopPhoto()">' +
    '<div style="flex:1;min-width:0;padding-right:40px">' +
    '<div style="font-weight:800;font-size:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(shopName(myShop)) + "</div>" +
    (myShop.ownerName ? '<div class="muted" style="font-size:13px">👤 ' + esc(myShop.ownerName) + "</div>" : "") +
    (shopAddr ? '<div class="muted" style="font-size:13px">📍 ' + esc(shopAddr) + "</div>" : "") +
    (myShop.phone ? '<div class="muted" style="font-size:13px">📞 ' + esc(myShop.phone) + "</div>" : "") +
    (myShop.wechatId ? '<div class="muted" style="font-size:13px">💬 ' + esc(myShop.wechatId) + "</div>" : "") +
    (myShop.deliveryFee > 0 ? '<div class="muted" style="font-size:13px">🛵 ' + money(myShop.deliveryFee) + "</div>" : "") +
    "</div></div>" +
    '<div class="tabs">' +
    '<div class="tab' + (vendorTab === "menu" ? " active" : "") + '" onclick="setVendorTab(\'menu\')">🍜 ' + esc(t("menu")) + "</div>" +
    '<div class="tab' + (vendorTab === "chats" ? " active" : "") + '" onclick="setVendorTab(\'chats\')">💬 ' + esc(t("tabChats")) + "</div>" +
    '<div class="tab' + (vendorTab === "orders" ? " active" : "") + '" onclick="setVendorTab(\'orders\')">📦 ' + esc(t("tabOrders")) + "</div>" +
    '<div class="tab' + (vendorTab === "posts" ? " active" : "") + '" onclick="setVendorTab(\'posts\')">📢 ' + esc(t("posts")) + "</div>" +
    "</div><div id=\"vtab\"></div>";
  if (vendorTab === "info") drawVendorInfo();
  if (vendorTab === "menu") drawVendorMenu();
  if (vendorTab === "chats") drawVendorChats();
  if (vendorTab === "orders") drawVendorOrders();
  if (vendorTab === "posts") drawVendorPosts();
}
function setVendorTab(tab) { vendorTab = tab; viewVendor(); }
function drawVendorInfo() {
  const box = document.getElementById("vtab");
  box.innerHTML = showShopForm ? shopForm(myShop) : "";
}
function editShopInfo() {
  if (vendorTab === "info" && showShopForm) showShopForm = false;
  else { vendorTab = "info"; showShopForm = true; }
  viewVendor();
}
function shopForm(s) {
  const v = (k) => esc(s[k] || "");
  return '<div class="card"><h3>' + esc(myShop ? t("saveShop") : t("createShop")) + "</h3>" +
    '<div class="field"><label>' + esc(t("shopName")) + '</label><input id="s-zh" value="' + v("name_zh") + '"></div>' +
    '<div class="field"><label>' + esc(t("ownerName")) + '</label><input id="s-owner" value="' + v("ownerName") + '"></div>' +
    '<div class="field"><label>' + esc(t("address")) + '</label><input id="s-azh" value="' + v("address_zh") + '"></div>' +
    '<div class="field"><label>' + esc(t("phone")) + '</label><input id="s-phone" value="' + v("phone") + '"></div>' +
    '<div class="field"><label>' + esc(t("wechatId")) + '</label><input id="s-wechat" value="' + v("wechatId") + '"></div>' +
    '<div class="field"><label>' + esc(t("deliveryFeeYuan")) + '</label><input id="s-fee" type="number" min="0" step="1" value="' + esc(s.deliveryFee != null ? s.deliveryFee : 0) + '"></div>' +
    '<div class="field"><label>' + esc(t("allCategories")) + '</label><select id="s-cat">' +
    CATEGORIES.filter(c => c.id !== "all").map(c =>
      '<option value="' + c.id + '"' + (s.category === c.id ? " selected" : "") + ">" + esc(catName(c.id)) + "</option>").join("") +
    "</select></div>" +
    '<button class="btn" style="width:100%" onclick="saveShop()">' + esc(t("save")) + "</button></div>";
}
async function saveShop() {
  const data = {
    name_zh: document.getElementById("s-zh").value.trim(),
    // Single-field form now: keep any previously saved other-language values.
    name_my: (myShop && myShop.name_my) || "",
    name_en: (myShop && myShop.name_en) || "",
    owner_name: document.getElementById("s-owner").value.trim(),
    address_zh: document.getElementById("s-azh").value.trim(),
    address_my: (myShop && myShop.address_my) || "",
    phone: document.getElementById("s-phone").value.trim(),
    wechat_id: document.getElementById("s-wechat").value.trim() || null,
    delivery_fee_yuan: Math.max(0, Number(document.getElementById("s-fee").value) || 0),
    category: document.getElementById("s-cat").value,
    emoji: (myShop && myShop.emoji) || "🍜",
    owner_id: currentUser.id,
    sample: false
  };
  if (!data.name_zh) { toast("⚠️"); return; }
  try {
    if (!myShop) data.photo_url = null;
    else data.photo_url = myShop.photo_url || null;
    if (myShop) {
      const { error } = await sb.from("shops").update(data).eq("id", myShop.id);
      if (error) throw error;
    } else {
      const { error } = await sb.from("shops").insert(data);
      if (error) throw error;
    }
    vendorTab = "info"; showShopForm = false; viewVendor();
  } catch (e) { toast("⚠️ " + e.message); }
}
async function uploadShopPhoto() {
  const fileInput = document.getElementById("v-photo");
  const file = fileInput && fileInput.files && fileInput.files[0];
  if (!file || !myShop) return;
  try {
    if (!file.type.startsWith("image/")) { toast("⚠️ " + t("photoOnlyImages")); return; }
    if (file.size > 5 * 1024 * 1024) { toast("⚠️ " + t("photoTooBig")); return; }
    toast("⏳ " + t("uploadingPhoto"));
    const ext = ((file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "")) || "jpg";
    const path = myShop.id + "/" + Date.now() + "." + ext;
    const { error: upErr } = await sb.storage.from("shop-photos").upload(path, file);
    if (upErr) throw upErr;
    const url = sb.storage.from("shop-photos").getPublicUrl(path).data.publicUrl;
    const { error } = await sb.from("shops").update({ photo_url: url }).eq("id", myShop.id);
    if (error) throw error;
    viewVendor();
  } catch (e) { toast("⚠️ " + e.message); }
}
async function drawVendorMenu() {
  const box = document.getElementById("vtab");
  box.innerHTML = '<div class="center muted">…</div>';
  const { data, error } = await sb.from("menu_items").select("*").eq("shop_id", myShop.id).order("created_at");
  if (error) { box.innerHTML = "⚠️ " + esc(error.message); return; }
  const items = (data || []).map(mapItem);
  box.innerHTML =
    '<button class="btn" style="width:100%;margin-bottom:12px" onclick="toggleMenuForm()">➕ ' + esc(t("addItem")) + "</button>" +
    (showMenuForm
      ? '<div class="card"><h3>➕ ' + esc(t("addItem")) + "</h3>" +
        '<div class="field"><input id="m-zh" placeholder="' + esc(t("itemName")) + '"></div>' +
        '<div class="field"><input id="m-price" type="number" min="0" placeholder="' + esc(t("priceYuan")) + '"></div>' +
        '<div class="field"><input id="m-photo" placeholder="' + esc(t("photoUrl")) + '"></div>' +
        '<button class="btn" style="width:100%" onclick="addMenuItem()">' + esc(t("add")) + "</button></div>"
      : "") +
    '<div class="card">' + (items.length ? items.map(it =>
      '<div class="menu-item"><div class="info"><div class="nm">' + esc(itemName(it)) + ' <span data-rp="' + it.id + '"></span></div>' +
      '<div class="pr">' + money(it.price) + "</div></div>" +
      '<button class="btn small gray" onclick="delMenuItem(\'' + it.id + "')\">" + esc(t("del")) + "</button></div>"
    ).join("") : '<div class="muted center">—</div>') + "</div>";
  loadRateBadges(box);
}
async function addMenuItem() {
  const nzh = document.getElementById("m-zh").value.trim();
  const nmy = "", nen = "";
  const price = Number(document.getElementById("m-price").value);
  const photoUrl = document.getElementById("m-photo").value.trim();
  if (!nzh || !(price >= 0)) { toast("⚠️"); return; }
  try {
    const { error } = await sb.from("menu_items").insert({
      shop_id: myShop.id,
      // default to the shop's category so the item appears under the right
      // category chip on the homepage
      category: myShop.category || "foods",
      name_zh: nzh, name_my: nmy, name_en: nen, price_yuan: price,
      photo_url: photoUrl || null, available: true, sample: false
    });
    if (error) throw error;
    showMenuForm = false;
    drawVendorMenu();
  } catch (e) { toast("⚠️ " + e.message); }
}
function toggleMenuForm() { showMenuForm = !showMenuForm; drawVendorMenu(); }
async function delMenuItem(itemId) {
  if (!(await confirmDlg(t("confirmDelete")))) return;
  try {
    const { error } = await sb.from("menu_items").delete().eq("id", itemId);
    if (error) throw error;
    drawVendorMenu();
  } catch (e) { toast("⚠️ " + e.message); }
}
/* ---------- all-my-chats view (customer + vendor) ----------
 * One place for every conversation: unread badges, tap to open inline.
 * Incoming messages land here live with popup + sound. */
async function viewChats() {
  if (needLogin()) return;
  const role = (userDoc && userDoc.role) || "customer";
  const isV = role === "vendor";
  window._openChatsView = null;
  const app = document.getElementById("app");
  app.innerHTML = '<h2>💬 ' + esc(t("chat")) + '</h2>' +
    '<div id="chats-list"><div class="center muted">\u2026</div></div><div id="chats-view"></div>';
  const col = isV ? "vendor_id" : "customer_id";
  const readKey = isV ? "vendorReadAt" : "customerReadAt";

  const render = async () => {
    const listBox = document.getElementById("chats-list");
    if (!listBox) return;
    try {
      const { data, error } = await sb.from("conversations").select("*")
        .eq(col, currentUser.id).order("last_message_at", { ascending: false });
      if (error) throw error;
      const list = (data || []).map(mapConv);
      let names = {};
      if (!isV) {
        const sids = [...new Set(list.map(c => c.shopId).filter(Boolean))];
        if (sids.length) {
          const { data: shops } = await sb.from("shops").select("id,name_zh,name_my,name_en").in("id", sids);
          (shops || []).forEach(x => names[x.id] = shopName(mapShop(x)));
        }
      }
      const convById = {};
      window._chatsLastMsg = window._chatsLastMsg || {};
      list.forEach(c => {
        convById[c.id] = c;
        if (!(c.id in window._chatsLastMsg)) window._chatsLastMsg[c.id] = c.lastMessageAt;
      });
      const unread = await unreadCounts(list.map(c => c.id), readKey, convById);
      window._totalUnread = Object.values(unread).reduce((a, b) => a + b, 0);
      syncChatTabBadge();
      refreshTotalUnread(false);
      if (!list.length) { listBox.innerHTML = '<div class="card center muted">' + esc(t("noChats")) + "</div>"; return; }
      listBox.innerHTML = list.map(c => {
        const nm = isV ? (c.customerName || "\u2026") : (names[c.shopId] || "\u2026");
        return '<div class="card shop-card" data-conv="' + c.id + '" data-nm="' + esc(nm) + '"><div class="shop-emoji">' + (isV ? "👤" : "🏪") + "</div>" +
          '<div style="flex:1"><h3>' + esc(nm) +
          (unread[c.id] ? ' <span class="ubadge">' + unread[c.id] + "</span>" : "") + "</h3>" +
          '<div class="meta">' + esc(fmtTime(c.lastMessageAt)) + "</div></div></div>";
      }).join("");
      listBox.querySelectorAll("[data-conv]").forEach(el =>
        el.onclick = () => {
          const b = el.querySelector(".ubadge");
          const n = b ? Number(b.textContent) || 0 : 0;
          if (b) b.remove();
          if (n) window._totalUnread = Math.max(0, (window._totalUnread || 0) - n);
          const cid = el.getAttribute("data-conv");
          window._openChatsView = cid;
          const view = document.getElementById("chats-view");
          mountChat(view, cid, el.getAttribute("data-nm") || "");
          const h3 = view.querySelector("h3");
          if (h3 && !h3.querySelector(".chat-x")) {
            const x = document.createElement("button");
            x.className = "btn small gray chat-x";
            x.style.cssText = "float:right";
            x.textContent = "\u2715";
            x.onclick = () => { view.innerHTML = ""; window._openChatsView = null; };
            h3.appendChild(x);
          }
          view.scrollIntoView({ block: "nearest", behavior: "smooth" });
        });
    } catch (e) { listBox.innerHTML = "\u26A0\uFE0F " + esc(e.message); }
  };
  await render();

  const ch = sb.channel("chats-page-" + currentUser.id)
    .on("postgres_changes",
      { event: "*", schema: "public", table: "conversations", filter: col + "=eq." + currentUser.id },
      async (payload) => {
        const n = payload && payload.new;
        if (payload && payload.eventType === "INSERT" && n) {
          window._chatsLastMsg = window._chatsLastMsg || {};
          window._chatsLastMsg[n.id] = n.last_message_at;
          notifyPing("💬 " + t("newChat"));
        } else if (payload && payload.eventType === "UPDATE" && n) {
          const seen = (window._chatsLastMsg || {})[n.id];
          if (seen !== n.last_message_at) {
            window._chatsLastMsg = window._chatsLastMsg || {};
            window._chatsLastMsg[n.id] = n.last_message_at;
            if (window._openChatsView !== n.id) {
              const { data: lm } = await sb.from("messages").select("sender_id,body,kind")
                .eq("conversation_id", n.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
              if (lm && lm.sender_id !== currentUser.id) {
                const preview = lm.kind === "image" ? "📷 " + t("photoSent")
                  : lm.kind === "video" ? "🎥 " + t("videoSent")
                  : (lm.body || "").slice(0, 40);
                notifyPing("💬 " + preview);
              }
            }
          }
        }
        render();
      })
    .subscribe();
  unsubs.push(ch);
}

async function drawVendorChats() {
  const box = document.getElementById("vtab");
  box.innerHTML = '<div id="chatlist"><div class="center muted">\u2026</div></div><div id="chatview"></div>';
  await renderChatList();
  // realtime: new chats + new messages (last_message_at changes) pop in live.
  // NOTE: only re-renders the LIST so an open #chatview is never wiped.
  const ch = sb.channel("vendor-chats-" + currentUser.id)
    .on("postgres_changes",
      { event: "*", schema: "public", table: "conversations", filter: "vendor_id=eq." + currentUser.id },
      (payload) => {
        const n = payload && payload.new;
        if (payload && payload.eventType === "INSERT" && n) {
          window._vendorLastMsgAt = window._vendorLastMsgAt || {};
          window._vendorLastMsgAt[n.id] = n.last_message_at;
          notifyPing("💬 " + t("newChat"));
        } else if (payload && payload.eventType === "UPDATE" && n) {
          const seen = (window._vendorLastMsgAt || {})[n.id];
          if (seen !== n.last_message_at) {
            window._vendorLastMsgAt = window._vendorLastMsgAt || {};
            window._vendorLastMsgAt[n.id] = n.last_message_at;
            // confirm the latest message is from the customer before pinging
            sb.from("messages").select("sender_id,body,kind").eq("conversation_id", n.id)
              .order("created_at", { ascending: false }).limit(1).maybeSingle()
              .then(({ data: lm }) => {
                if (lm && lm.sender_id !== currentUser.id) {
                  const c = (window._vendorConvs || {})[n.id] || {};
                  const preview = lm.kind === "image" ? "📷 " + t("photoSent")
                    : lm.kind === "video" ? "🎥 " + t("videoSent")
                    : (lm.body || "").slice(0, 40);
                  notifyPing("💬 " + (c.customerName ? c.customerName + ": " : "") + preview);
                }
              });
          }
        }
        renderChatList();
      })
    .subscribe();
  unsubs.push(ch);
}
/* Render only the conversation list (badges included); keeps #chatview intact. */
async function renderChatList() {
  const listBox = document.getElementById("chatlist");
  if (!listBox) return [];
  const { data, error } = await sb.from("conversations").select("*")
    .eq("vendor_id", currentUser.id).order("last_message_at", { ascending: false });
  if (error) { listBox.innerHTML = "\u26A0\uFE0F " + esc(error.message); return []; }
  const list = (data || []).map(mapConv);
  const convById = {};
  window._vendorLastMsgAt = window._vendorLastMsgAt || {};
  list.forEach(c => {
    convById[c.id] = c;
    if (!(c.id in window._vendorLastMsgAt)) window._vendorLastMsgAt[c.id] = c.lastMessageAt;
  });
  window._vendorConvs = convById;
  const unread = await unreadCounts(list.map(c => c.id), "vendorReadAt", convById);
  if (!list.length) { listBox.innerHTML = '<div class="card center muted">' + esc(t("noChats")) + "</div>"; return []; }
  listBox.innerHTML = list.map(c =>
    '<div class="card shop-card" data-conv="' + c.id + '"><div class="shop-emoji">👤</div>' +
    '<div style="flex:1"><h3>' + esc(c.customerName || "\u2026") +
    (unread[c.id] ? ' <span class="ubadge">' + unread[c.id] + "</span>" : "") + "</h3>" +
    '<div class="meta">' + esc(fmtTime(c.lastMessageAt)) + "</div></div></div>").join("");
  listBox.querySelectorAll("[data-conv]").forEach(el =>
    el.onclick = () => {
      const b = el.querySelector(".ubadge");
      if (b) b.remove();
      mountChat(document.getElementById("chatview"), el.getAttribute("data-conv"), "💬");
    });
  return list.map(c => c.id);
}
async function drawVendorOrders() {
  const box = document.getElementById("vtab");
  // realtime first: vendor hears about new orders even with an empty list
  const ch = sb.channel("vendor-orders-" + currentUser.id)
    .on("postgres_changes",
      { event: "*", schema: "public", table: "orders", filter: "vendor_id=eq." + currentUser.id },
      (payload) => {
        if (payload && payload.eventType === "INSERT") notifyPing("🔔 " + t("newOrder"));
        stopListeners(); drawVendorOrders();
      })
    .subscribe();
  unsubs.push(ch);
  box.innerHTML = '<div class="center muted">…</div>';
  const { data, error } = await sb.from("orders").select("*")
    .eq("vendor_id", currentUser.id).order("created_at", { ascending: false });
  if (error) { box.innerHTML = "⚠️ " + esc(error.message); return; }
  const list = (data || []).map(mapOrder);
  if (!list.length) { box.innerHTML = '<div class="card center muted">' + esc(t("noOrders")) + "</div>"; return; }
  box.innerHTML = list.map(o =>
    orderCard(o, { name_zh: t("orderFrom") + ": " + (o.customerName || "?") + (o.customerEmail ? " (" + o.customerEmail + ")" : ""), name_my: "", name_en: "" }, true)
  ).join("");
}

/* ---------- vendor posts （商家动态） ---------- */
async function drawVendorPosts() {
  const box = document.getElementById("vtab");
  box.innerHTML = '<div class="center muted">…</div>';
  let listHtml = "";
  try {
    const { data, error } = await sb.from("posts").select("*")
      .eq("shop_id", myShop.id).order("created_at", { ascending: false });
    if (error) throw error;
    const list = (data || []).map(mapPost);
    listHtml = list.length ? '<div class="dish-grid">' + list.map(p =>
      '<div class="dish-card">' +
      (p.photoUrl
        ? '<div class="dish-photo"><img src="' + esc(p.photoUrl) + '" alt="" loading="lazy"></div>'
        : '<div class="dish-photo ph-all">📢</div>') +
      '<div class="dish-body"><div class="dish-name">' + esc(p.body) + '</div>' +
      '<div class="dish-foot"><span class="dish-price">' + money(p.price) + "</span>" +
      '<button class="btn small gray" onclick="delPost(\'' + p.id + "')\">" + esc(t("del")) + "</button></div>" +
      '<div class="muted" style="font-size:11px">' + esc(fmtTime(p.createdAt)) + "</div></div></div>"
    ).join("") + "</div>" : '<div class="card center muted">' + esc(t("noPosts")) + "</div>";
  } catch (e) { listHtml = '<div class="card">⚠️ ' + esc(e.message) + "</div>"; }
  box.innerHTML =
    '<button class="btn" style="width:100%;margin-bottom:12px" onclick="togglePostForm()">📢 ' + esc(t("createPost")) + "</button>" +
    (showPostForm
      ? '<div class="card"><h3>📢 ' + esc(t("createPost")) + "</h3>" +
        '<div class="field"><label>' + esc(t("allCategories")) + '</label><select id="p-cat">' +
        CATEGORIES.filter(c => c.id !== "all").map(c =>
          '<option value="' + c.id + '"' + ((myShop.category || "foods") === c.id ? " selected" : "") + ">" + esc(catName(c.id)) + "</option>").join("") +
        "</select></div>" +
        '<div class="field"><label>' + esc(t("postPhoto")) + '</label><input id="p-photo" type="file" accept="image/*"></div>' +
        '<div class="field"><textarea id="p-body" rows="3" placeholder="' + esc(t("postPlaceholder")) + '"></textarea></div>' +
        '<div class="field"><label>' + esc(t("priceYuan")) + '</label><input id="p-price" type="number" min="0" step="1"></div>' +
        '<button class="btn" style="width:100%" onclick="publishPost()">' + esc(t("publish")) + "</button>" +
        '<div id="p-err" class="muted" style="margin-top:6px"></div></div>'
      : "") +
    "<h3>📋 " + esc(t("myPosts")) + "</h3>" + listHtml;
}
function togglePostForm() { showPostForm = !showPostForm; drawVendorPosts(); }
async function publishPost() {
  const errBox = document.getElementById("p-err");
  const showErr = (m) => { if (errBox) errBox.textContent = "⚠️ " + m; };
  const body = (document.getElementById("p-body").value || "").trim();
  const priceRaw = (document.getElementById("p-price").value || "").trim();
  if (!body || priceRaw === "" || !(Number(priceRaw) >= 0)) { showErr(t("fillPostText")); return; }
  const fileInput = document.getElementById("p-photo");
  const file = fileInput && fileInput.files && fileInput.files[0];
  let photoUrl = null;
  try {
    if (file) {
      if (!file.type.startsWith("image/")) { showErr(t("photoOnlyImages")); return; }
      if (file.size > 5 * 1024 * 1024) { showErr(t("photoTooBig")); return; }
      showErr(t("uploadingPhoto"));
      const ext = ((file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "")) || "jpg";
      const path = myShop.id + "/" + Date.now() + "." + ext;
      const { error: upErr } = await sb.storage.from("post-photos").upload(path, file);
      if (upErr) throw upErr;
      photoUrl = sb.storage.from("post-photos").getPublicUrl(path).data.publicUrl;
    }
    const { error } = await sb.from("posts").insert({
      shop_id: myShop.id, vendor_id: currentUser.id,
      body: body, price_yuan: Number(priceRaw), photo_url: photoUrl,
      category: (document.getElementById("p-cat") || {}).value || "foods"
    });
    if (error) throw error;
    showPostForm = false;
    drawVendorPosts();
  } catch (e) { showErr(e.message || e); }
}
async function delPost(postId) {
  if (!(await confirmDlg(t("confirmDelete")))) return;
  try {
    // best-effort: also remove the uploaded photo from storage
    const { data: prow } = await sb.from("posts").select("photo_url").eq("id", postId).single();
    const url = prow && prow.photo_url;
    const { error } = await sb.from("posts").delete().eq("id", postId);
    if (error) throw error;
    if (url) {
      const marker = "/post-photos/";
      const i = url.indexOf(marker);
      if (i >= 0) {
        const path = url.slice(i + marker.length).split("?")[0];
        try { await sb.storage.from("post-photos").remove([path]); } catch (e2) {}
      }
    }
    drawVendorPosts();
  } catch (e) { toast("⚠️ " + e.message); }
}

/* Total unread across all my conversations (chat tab badge). */
async function countTotalUnread() {
  try {
    if (!currentUser) return 0;
    const role = (userDoc && userDoc.role) || "customer";
    const isV = role === "vendor";
    const col = isV ? "vendor_id" : "customer_id";
    const rcol = isV ? "vendor_last_read_at" : "customer_last_read_at";
    const rkey = isV ? "vendorReadAt" : "customerReadAt";
    const { data } = await sb.from("conversations").select("id," + rcol).eq(col, currentUser.id);
    const list = data || [];
    if (!list.length) return 0;
    const convById = {};
    list.forEach(c => convById[c.id] = { [rkey]: c[rcol] });
    const counts = await unreadCounts(list.map(c => c.id), rkey, convById);
    return Object.values(counts).reduce((a, b) => a + b, 0);
  } catch (e) { return 0; }
}
function syncChatTabBadge() {
  const n = window._totalUnread || 0;
  const btn = document.querySelector('#tapbar [data-h="#/chats"]');
  if (!btn) return;
  let b = btn.querySelector(".cbadge");
  if (n > 0) {
    if (!b) { b = document.createElement("span"); b.className = "cbadge"; btn.appendChild(b); }
    b.textContent = n;
  } else if (b) b.remove();
}
async function refreshTotalUnread(force) {
  if (!currentUser) { window._totalUnread = 0; syncChatTabBadge(); return 0; }
  const now = Date.now();
  if (!force && window._tuAt && now - window._tuAt < 5000) { syncChatTabBadge(); return window._totalUnread || 0; }
  window._tuAt = now;
  const n = await countTotalUnread();
  window._totalUnread = n;
  syncChatTabBadge();
  return n;
}
/* One silent global watcher: any new message in any of my conversations
 * refreshes the chat tab badge, wherever I am in the app. */
let _gcCh = null;
function ensureGlobalChatWatch() {
  const uid = currentUser && currentUser.id;
  if (!uid || typeof sb === "undefined") return;
  if (_gcCh && _gcCh._uid === uid) return;
  if (_gcCh) { try { sb.removeChannel(_gcCh); } catch (e) {} _gcCh = null; }
  const role = (userDoc && userDoc.role) || "customer";
  const col = role === "vendor" ? "vendor_id" : "customer_id";
  const ch = sb.channel("global-chats-" + uid)
    .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "conversations", filter: col + "=eq." + uid },
      (payload) => {
        const n = payload && payload.new;
        if (!n) return;
        window._chatsLastMsg = window._chatsLastMsg || {};
        if (window._chatsLastMsg[n.id] !== n.last_message_at) {
          window._chatsLastMsg[n.id] = n.last_message_at;
          refreshTotalUnread(true);
        } else {
          refreshTotalUnread(false);
        }
      })
    .subscribe();
  ch._uid = uid;
  _gcCh = ch;
}

/* Bottom tap bar: Home | Cart(badge) | Orders | Vendor? | Profile. */
function renderTapbar() {
  let bar = document.getElementById("tapbar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "tapbar";
    bar.className = "tapbar";
    document.body.appendChild(bar);
  }
  const h = location.hash || "#/";
  const role = userDoc && userDoc.role;
  const cc = (typeof cartCount === "function") ? cartCount() : 0;
  const isV = role === "vendor" || role === "admin";
  const tu = window._totalUnread || 0;
  const chatTab = { ic: "💬", label: t("chat"), hash: "#/chats", active: h === "#/chats", badge: tu };
  let tabs;
  if (isV) {
    tabs = [
      { ic: "🏠", label: t("home"), hash: "#/", active: h === "#/" || !h.startsWith("#/") },
      chatTab,
      { ic: "🏪", label: t("vendorCenter"), hash: "#/vendor", active: h === "#/vendor" }
    ];
    if (role === "admin")
      tabs.push({ ic: "🛠", label: t("adminPanel"), hash: "#/admin", active: h === "#/admin" });
    tabs.push({ ic: "👤", label: t("profile"), hash: "#/profile", active: h === "#/profile" });
  } else {
    tabs = [
      { ic: "🏠", label: t("home"), hash: "#/", active: h === "#/" || !h.startsWith("#/") },
      { ic: "🛒", label: t("cart"), hash: "#/cart", active: h === "#/cart", badge: cc }
    ];
    if (currentUser) tabs.push({ ic: "📦", label: t("orders"), hash: "#/orders", active: h === "#/orders" });
    tabs.push(chatTab);
    tabs.push({ ic: "👤", label: t("profile"), hash: "#/profile", active: h === "#/profile" });
  }
  refreshTotalUnread(false);
  bar.innerHTML = tabs.map(tb =>
    '<button class="' + (tb.active ? "active" : "") + '" data-h="' + tb.hash + '">' +
    '<span class="ic">' + tb.ic + "</span><span>" + esc(tb.label) + "</span>" +
    (tb.badge ? '<span class="cbadge">' + tb.badge + "</span>" : "") + "</button>").join("");
  bar.querySelectorAll("button").forEach(b =>
    b.onclick = () => { location.hash = b.getAttribute("data-h"); });
}

/* ---------- admin ---------- */
async function viewAdmin() {
  if (needLogin()) return;
  const app = document.getElementById("app");
  if (!userDoc || userDoc.role !== "admin") {
    app.innerHTML = '<div class="notice">⚠️ ' + esc(t("loginFirst")) + "</div>";
    return;
  }
  app.innerHTML = "<h2>🛠 " + esc(t("adminPanel")) + "</h2>" +
    '<div class="notice">' + esc(t("makeAdminTip")) + "</div>" +
    '<div class="tabs">' +
    '<div class="tab' + (adminTab === "shops" ? " active" : "") + '" onclick="setAdminTab(\'shops\')">🏪 ' + esc(t("allShops")) + "</div>" +
    '<div class="tab' + (adminTab === "users" ? " active" : "") + '" onclick="setAdminTab(\'users\')">👥 ' + esc(t("allUsers")) + "</div>" +
    '<div class="tab' + (adminTab === "orders" ? " active" : "") + '" onclick="setAdminTab(\'orders\')">📦 ' + esc(t("allOrders")) + "</div>" +
    "</div><div id=\"atab\"></div>";
  const box = document.getElementById("atab");
  if (adminTab === "shops") {
    const { data, error } = await sb.from("shops").select("*");
    if (error) { box.innerHTML = "⚠️ " + esc(error.message); return; }
    const list = (data || []).map(mapShop);
    box.innerHTML =
      '<div class="card"><div class="rowbtns">' +
      '<button class="btn small" onclick="importSamples()">📥 ' + esc(t("loadSamples")) + "</button>" +
      '<button class="btn small gray" onclick="deleteSamples()">🗑 ' + esc(t("deleteSamples")) + "</button>" +
      "</div></div>" +
      list.map(s => '<div class="card"><b>' + esc(shopName(s)) + "</b>" +
        (s.sample ? '<span class="badge">' + esc(t("sampleBadge")) + "</span>" : "") +
        '<div class="muted">' + esc(s.ownerName || "") + " · " + esc(s.phone || "") + "</div>" +
        '<div class="rowbtns"><button class="btn small gray" onclick="adminDelShop(\'' + s.id + "')\">" + esc(t("del")) + "</button></div></div>").join("");
  } else if (adminTab === "users") {
    const { data, error } = await sb.from("users").select("*");
    if (error) { box.innerHTML = "⚠️ " + esc(error.message); return; }
    const list = (data || []).map(mapUser);
    box.innerHTML = '<div class="card"><table class="list"><tr><th>' + esc(t("yourName")) +
      "</th><th>" + esc(t("email")) + "</th><th>role</th></tr>" +
      list.map(u => "<tr><td>" + esc(u.name || "") + "</td><td>" + esc(u.email || "") + "</td><td>" + esc(u.role || "") + "</td></tr>").join("") +
      "</table></div>";
  } else {
    const { data, error } = await sb.from("orders").select("*").order("created_at", { ascending: false });
    if (error) { box.innerHTML = "⚠️ " + esc(error.message); return; }
    const list = (data || []).map(mapOrder);
    box.innerHTML = list.length ? list.map(o =>
      '<div class="card"><b>' + money(o.total) + '</b> <span class="status ' + o.status + '">' + esc(t("status_" + o.status)) + "</span>" +
      '<div class="muted">' + esc(String(o.id).slice(0, 8)) + " · " + esc(fmtTime(o.createdAt)) + "</div></div>").join("")
      : '<div class="card center muted">' + esc(t("noOrders")) + "</div>";
  }
}
function setAdminTab(tab) { adminTab = tab; viewAdmin(); }
async function adminDelShop(id) {
  if (!(await confirmDlg(t("confirmDelete")))) return;
  try {
    // menu_items cascade-deletes via FK
    const { error } = await sb.from("shops").delete().eq("id", id);
    if (error) throw error;
    viewAdmin();
  } catch (e) { toast("⚠️ " + e.message); }
}
async function importSamples() {
  if (!(await confirmDlg(t("loadSamples") + "?"))) return;
  try {
    for (const s of SAMPLE_SHOPS) {
      const { menu, id, ...data } = s;
      const { data: ins, error: sErr } = await sb.from("shops").insert({
        name_zh: data.name_zh, name_my: data.name_my, name_en: data.name_en,
        owner_name: data.ownerName, address_zh: data.address_zh, address_my: data.address_my,
        phone: data.phone, category: data.category, emoji: data.emoji,
        sample: true, owner_id: currentUser.id
      }).select("id").single();
      if (sErr) throw sErr;
      const rows = menu.map(m => ({
        shop_id: ins.id, category: m.category,
        name_zh: m.name_zh, name_my: m.name_my, name_en: m.name_en,
        price_yuan: m.price, emoji: m.emoji, photo_url: m.photoUrl || null,
        available: true, sample: true
      }));
      const { error: mErr } = await sb.from("menu_items").insert(rows);
      if (mErr) throw mErr;
    }
    toast("✅");
    viewAdmin();
  } catch (e) { toast("⚠️ " + e.message); }
}
async function deleteSamples() {
  if (!(await confirmDlg(t("deleteSamples") + "?"))) return;
  try {
    const { data, error } = await sb.from("shops").select("id").eq("sample", true);
    if (error) throw error;
    for (const s of (data || [])) {
      const { error: dErr } = await sb.from("shops").delete().eq("id", s.id);
      if (dErr) throw dErr;
    }
    viewAdmin();
  } catch (e) { toast("⚠️ " + e.message); }
}
