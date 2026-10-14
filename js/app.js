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
  return { id: r.id, role: r.role, name: nm || r.email || "", first_name: r.first_name, last_name: r.last_name, email: r.email, phone: r.phone, avatarUrl: r.avatar_url || "", banned: !!r.banned, driverApproved: !!r.driver_approved };
}
function mapShop(r) {
  if (!r) return r;
  return {
    id: r.id, name_zh: r.name_zh, name_my: r.name_my, name_en: r.name_en,
    ownerName: r.owner_name, address_zh: r.address_zh, address_my: r.address_my,
    phone: r.phone, category: r.category, emoji: r.emoji, sample: r.sample,
    deliveryFee: Number(r.delivery_fee_yuan) || 0, wechatId: r.wechat_id || "",
    photo_url: r.photo_url || null, approved: r.approved !== false, wavepay: r.wavepay_number || "", kbzpay: r.kbzpay_number || "",
    ownerUid: r.owner_id, createdAt: r.created_at, isOpen: r.is_open !== false
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
    customerName: r.customer_name, customerAvatarUrl: r.customer_avatar_url || "",
    lastMessageAt: r.last_message_at, createdAt: r.created_at,
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
    customerEmail: r.customer_email, createdAt: r.created_at, payMethod: r.payment_method || "cod", payTxn: r.payment_txn || "",
    driverId: r.driver_id || null, driverArchived: r.driver_archived === true,
    vendorArchived: r.vendor_archived === true
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
/* prettyToast: floating pill with pop animation (cooler than modal toast) */
function prettyToast(icon, msg, color) {
  let el = document.getElementById("ptoast");
  if (!el) {
    el = document.createElement("div");
    el.id = "ptoast";
    el.className = "ptoast";
    document.body.appendChild(el);
  }
  el.className = "ptoast " + (color || "");
  el.innerHTML = '<span class="pic">' + icon + '</span><span>' + esc(msg) + "</span>";
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("show")));
  clearTimeout(window._ptoastT);
  window._ptoastT = setTimeout(() => el.classList.remove("show"), 2200);
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
  try { applyTheme(); } catch (e) {}
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
    if (window._drvCh) { try { sb.removeChannel(window._drvCh); } catch (e) {} window._drvCh = null; }
    if (window._drvBc) { try { sb.removeChannel(window._drvBc); } catch (e) {} window._drvBc = null; }
    if (window._goCh) { try { sb.removeChannel(window._goCh); } catch (e) {} window._goCh = null; }
    if (typeof _goCh !== "undefined") _goCh = null;
    window._totalUnread = 0; window._tuAt = 0; window._chatsLastMsg = {};
  }
  if (currentUser) {
    try {
      // blocked: admin-deleted accounts can't log back in
      try {
        const { data: del } = await sb.from("deleted_users").select("id").eq("id", currentUser.id).single();
        if (del) {
          try { await sb.auth.signOut(); } catch (e) {}
          currentUser = null; userDoc = null;
          toast(t("accountDeleted") || "Account deleted");
          location.hash = "#/";
          return;
        }
      } catch (e) {}
      const { data, error } = await sb.from("users").select("*").eq("id", currentUser.id).single();
      if (!error && data) {
        userDoc = mapUser(data);
    if (userDoc && userDoc.banned) {
      try { await sb.auth.signOut(); } catch (e) {}
      currentUser = null; userDoc = null;
      toast(t("accountBanned"));
      location.hash = "#/";
      return;
    }
        // backfill: push my avatar onto conversations missing it (e.g. uploaded before v13)
        if (userDoc && userDoc.avatarUrl) {
          sb.from("conversations").update({ customer_avatar_url: userDoc.avatarUrl })
            .eq("customer_id", currentUser.id).is("customer_avatar_url", null)
            .then(() => {}, () => {});
        }
      } else {
        // First login via OAuth (e.g. Google): create the profile row.
        // (Email signups insert their own row in doCreateAccount.)
        let oauthRole = "customer";
        try { oauthRole = localStorage.getItem("mf_oauth_role") || "customer"; localStorage.removeItem("mf_oauth_role"); } catch (e) {}
        const { error: insErr } = await sb.from("users").insert({
          id: currentUser.id, role: oauthRole,
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
  ensureGlobalOrderWatch();
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
    { icon: ICONS.user, label: t("profile"), hash: "#/profile" },
    { icon: ICONS.box, label: t("orders"), hash: "#/orders" },
    { icon: ICONS.gear, label: t("settings"), hash: "#/settings" },
    { icon: ICONS.help, label: t("help"), hash: "#/help" },
    { icon: ICONS.phone, label: t("contactUs"), hash: "#/contact" },
    { icon: ICONS.logout, label: t("logout"), hash: "#/logout" }
  ];
  box.innerHTML = items.map((it, i) =>
    '<div class="drawer-item" data-i="' + i + '"><span class="dic">' + it.icon + "</span><span>" + esc(it.label) + "</span></div>"
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
  if (h.startsWith("#/chat/")) { const cid = h.split("/")[2]; return viewChatPage(cid); }
  if (h === "#/chats") return viewChats();
  if (h === "#/vendor/orders") return viewVendorOrdersPage();
  if (h === "#/driver") return viewDriver();
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
async function uploadAvatar() {
  const inp = document.getElementById("avatar-inp");
  const file = inp && inp.files && inp.files[0];
  if (!file || !currentUser) return;
  try {
    if (!file.type.startsWith("image/")) { toast("\u26A0\uFE0F " + t("photoOnlyImages")); return; }
    if (file.size > 5 * 1024 * 1024) { toast("\u26A0\uFE0F " + t("photoTooBig")); return; }
    toast("\u23F3 " + t("uploadingPhoto"));
    const ext = ((file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "")) || "jpg";
    const path = currentUser.id + "/" + Date.now() + "." + ext;
    const { error: upErr } = await sb.storage.from("avatars").upload(path, file);
    if (upErr) throw upErr;
    const url = sb.storage.from("avatars").getPublicUrl(path).data.publicUrl;
    const { error } = await sb.from("users").update({ avatar_url: url }).eq("id", currentUser.id);
    if (error) throw error;
    if (userDoc) userDoc.avatarUrl = url;
    try { await sb.from("conversations").update({ customer_avatar_url: url }).eq("customer_id", currentUser.id); } catch (e) {}
    viewProfile();
  } catch (e) { toast("\u26A0\uFE0F " + e.message); }
}
function viewProfile() {
  const app = document.getElementById("app");
  if (currentUser) {
    if (userDoc && userDoc.avatarUrl) {
      sb.from("conversations").update({ customer_avatar_url: userDoc.avatarUrl })
        .eq("customer_id", currentUser.id).is("customer_avatar_url", null)
        .then(() => {}, () => {});
    }
    app.innerHTML =
      '<div class="card"><h2>👤 ' + esc(t("myAccount")) + "</h2>" +
      (((userDoc && userDoc.role) === "vendor") ? "" :
      '<div class="center" style="margin-bottom:10px">' +
      ((userDoc && userDoc.avatarUrl)
        ? '<img src="' + esc(userDoc.avatarUrl) + '" alt="" style="width:96px;height:96px;border-radius:50%;object-fit:cover">'
        : '<div style="width:96px;height:96px;border-radius:50%;background:#fce4ec;display:inline-flex;align-items:center;justify-content:center;font-size:44px">👤</div>') +
      '<div style="margin-top:8px"><button class="btn small" onclick="document.getElementById(\'avatar-inp\').click()">' + esc(t("changePhoto")) + '</button>' +
      '<input type="file" id="avatar-inp" accept="image/*" style="display:none" onchange="uploadAvatar()"></div></div>') +
      '<div class="profile-row"><span class="k">' + esc(t("yourName")) + "</span>" +
      '<span id="p-name-row" style="display:flex;gap:6px;align-items:center">' +
      "<span>" + esc((userDoc && userDoc.name) || currentUser.email) + "</span>" +
      '<button class="btn small gray" onclick="editProfileName()">✏️</button></span></div>' +
      '<div class="profile-row"><span class="k">' + esc(t("email")) + "</span><span>" + esc(currentUser.email || "-") + "</span></div>" +
      '<div class="profile-row"><span class="k">' + esc(t("role")) + "</span><span>" + esc((userDoc && userDoc.role) || "-") + "</span></div>" +
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
        '<div class="tab' + (regRole === "driver" ? " active" : "") + '" onclick="setRegRole(\'driver\')">' + esc(t("iAmDriver")) + "</div>" +
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
function setRegRole(r) {
  // preserve typed inputs across the re-render
  const keep = {};
  ["r-name", "r-contact", "r-pass", "r-owner", "r-phone"].forEach(id => {
    const el = document.getElementById(id);
    if (el) keep[id] = el.value;
  });
  regRole = r;
  viewProfile();
  Object.keys(keep).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = keep[id];
  });
}
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
  // fallback: read active role tab from DOM in case regRole got out of sync
  try {
    const tabs = document.querySelectorAll(".role-pick .tab");
    tabs.forEach((tb, i) => {
      if (tb.classList.contains("active")) {
        const roles = ["customer", "vendor", "driver"];
        if (roles[i]) regRole = roles[i];
      }
    });
  } catch (e) {}
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
    try { localStorage.setItem("mf_oauth_role", regRole || "customer"); } catch (e) {}
    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + window.location.pathname }
    });
    if (error) throw error;
    // Browser redirects to Google; on return, handleSession() creates the
    // users row (role from mf_oauth_role) if this is the first login.
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
    '<div class="card" style="padding:10px 12px"><h2 style="font-size:16px;margin:0 0 8px">⚙️ ' + esc(t("settings")) + "</h2>" +
    '<div class="field" style="margin-bottom:4px"><label style="font-size:12px">' + esc(t("chooseLanguage")) + "</label>" +
    '<div id="lang-drop" class="lang-opt active" style="padding:8px 10px;font-size:13px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center" onclick="document.getElementById(\'lang-opts\').style.display=document.getElementById(\'lang-opts\').style.display===\'none\'?\'block\':\'none\'">' +
    "<span>" + (langs.find(([id]) => id === LANG) || langs[0])[1] + "</span><span>▾</span></div>" +
    '<div id="lang-opts" style="display:none">' +
    langs.filter(([id]) => id !== LANG).map(([id, label]) =>
      '<div class="lang-opt" style="padding:8px 10px;font-size:13px;margin-bottom:6px" onclick="setLang(\'' + id + "')\">" +
      "<span>" + label + "</span></div>"
    ).join("") + "</div></div></div>" +
    '<div class="card" style="padding:10px 12px"><h3 style="font-size:14px;margin:0 0 8px">📍 ' + esc(t("savedContact")) + "</h3>" +
    '<div class="field" style="margin-bottom:8px"><label style="font-size:12px">' + esc(t("deliveryAddress")) + '</label><input id="s-addr" style="padding:8px;font-size:13px" value="' + esc(getPref("addr", "")) + '"></div>' +
    '<div class="field" style="margin-bottom:8px"><label style="font-size:12px">' + esc(t("deliveryPhone")) + '</label><input id="s-phone" style="padding:8px;font-size:13px" value="' + esc(getPref("phone", "")) + '"></div>' +
    '<button class="btn" style="width:100%;padding:8px" onclick="savePrefs()">' + esc(t("save")) + "</button></div>" +
    '<div class="card" style="padding:10px 12px"><h3 style="font-size:14px;margin:0 0 6px">🔔 ' + esc(t("notifTitle")) + "</h3>" +
    '<div class="profile-row" style="align-items:center;font-size:13px"><span>' + esc(t("notifDesc")) + "</span>" +
    '<label class="switch"><input type="checkbox" id="s-notif"' + (getPref("notif", "1") === "1" ? " checked" : "") + ' onchange="toggleNotif()"><span class="slider"></span></label></div></div>' +
    '<div class="card" style="padding:10px 12px"><h3 style="font-size:14px;margin:0 0 6px">🌙 ' + esc(t("themeTitle")) + "</h3>" +
    '<div class="profile-row" style="align-items:center;font-size:13px"><span>' + esc(t("darkMode")) + "</span>" +
    '<label class="switch"><input type="checkbox" id="s-theme"' + (getPref("theme", "light") === "dark" ? " checked" : "") + ' onchange="toggleTheme()"><span class="slider"></span></label></div></div>';
}
function savePrefs() {
  setPref("addr", (document.getElementById("s-addr").value || "").trim());
  setPref("phone", (document.getElementById("s-phone").value || "").trim());
  prettyToast("✅", t("done"), "green");
}
function toggleNotif() {
  setPref("notif", document.getElementById("s-notif").checked ? "1" : "0");
}
function applyTheme() {
  const th = getPref("theme", "light");
  document.documentElement.setAttribute("data-theme", th);
}
function toggleTheme() {
  const dark = document.getElementById("s-theme").checked;
  setPref("theme", dark ? "dark" : "light");
  applyTheme();
}
/* Help: short trilingual FAQ. */
function viewHelp() {
  const app = document.getElementById("app");
  app.innerHTML =
    '<div class="card"><h2>❓ ' + esc(t("helpTitle")) + "</h2>" +
    "<h3>" + esc(t("helpQ1")) + "</h3><p>" + esc(t("helpA1")) + "</p>" +
    "<h3>" + esc(t("helpQ2")) + "</h3><p>" + esc(t("helpA2")) + "</p>" +
    "<h3>" + esc(t("helpQ3")) + "</h3><p>" + esc(t("helpA3")) + "</p>" +
    "<h3>" + esc(t("helpQ4")) + "</h3><p>" + esc(t("helpA4")) + "</p>" +
    "<h3>" + esc(t("helpQ5")) + "</h3><p>" + esc(t("helpA5")) + "</p></div>";
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
    const { data: shops, error } = await sb.from("shops").select("*, menu_items(*)").eq("approved", true);
    const openShops = (shops || []).filter(s => s.is_open !== false);
    window._shops = [];
    window._dishIndex = {};
    window._allDishes = [];
    if (!error && openShops) {
      for (const rs of openShops) {
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
/* Just the price + order/stepper part of a dish card (re-rendered alone on qty change). */
function dishFootHTML(d, inCart) {
  return '<div class="dish-price">' + money(d.price) + "</div>" +
    (inCart > 0
      ? '<div class="qty-ctrl"><button onclick="event.stopPropagation();dishOrder(\'' + d.key + "',-1)\">−</button><b>" + inCart + "</b>" +
        '<button onclick="event.stopPropagation();dishOrder(\'' + d.key + "',1)\">＋</button></div>"
      : '<button class="btn small" onclick="event.stopPropagation();dishOrder(\'' + d.key + "',1)\">" + esc(t("order")) + "</button>");
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
    return '<div class="dish-card" data-key="' + d.key + '" onclick="location.hash=\'#/shop/' + d.shopId + "'\"><div class=\"dish-photo-wrap\">" + dishPhotoHTML(d) +
      '<button class="fav-star' + (isFav(d.key) ? ' on' : '') + '" onclick="event.stopPropagation();toggleFav(\'' + d.key + '\')">' + (isFav(d.key) ? '\u2605' : '\u2606') + '</button></div>' +
      '<div class="dish-body">' +
      '<div class="dish-name">' + esc(nm) + "</div>" +
      (nm2 ? '<div class="dish-name2">' + esc(nm2) + "</div>" : "") +
      '<div class="dish-shop">🏪 ' + esc(shopLabel) + "</div>" +
      '<div data-rp="' + d.itemId + '"></div>' +
      '<div class="dish-foot">' + dishFootHTML(d, inCart) + "</div></div></div>";
  }).join("");
  loadRateBadges(box);
}
/* ---------- vendor posts feed (homepage + shop page) ----------
 * Post cards are compact like dish cards and orderable: tapping the order
 * button adds the post to the cart as a pseudo-dish. */
function postFootHTML(key, p, inCart) {
  return '<span class="dish-price">' + money(p.price) + "</span>" +
    (inCart > 0
      ? '<div class="qty-ctrl"><button onclick="event.stopPropagation();postOrder(\'' + key + "',-1)\">−</button><b>" + inCart + "</b>" +
        '<button onclick="event.stopPropagation();postOrder(\'' + key + "',1)\">＋</button></div>"
      : '<button class="btn small" onclick="event.stopPropagation();postOrder(\'' + key + "',1)\">" + esc(t("order")) + "</button>");
}
function postCardHTML(p, showShop) {
  const key = p.shopId + "__post_" + p.id;
  const inCart = cart.items[key] ? cart.items[key].qty : 0;
  const click = showShop ? ' onclick="location.hash=\'#/shop/' + p.shopId + "'\"" : "";
  const shopLabel = (showShop && p.shopName)
    ? '<div class="post-shop" onclick="event.stopPropagation();location.hash=\'#/shop/' + p.shopId + "'\">🏪 " + esc(p.shopName) + "</div>" : "";
  return '<div class="post-card" data-key="' + key + '"' + click + ">" +
    '<div class="post-photo" style="position:relative">' + (p.photoUrl ? '<img src="' + esc(p.photoUrl) + '" alt="" loading="lazy">' : "📢") +
    '<button class="fav-star' + (isFav(key) ? ' on' : '') + '" onclick="event.stopPropagation();toggleFav(\'' + key + '\')">' + (isFav(key) ? '\u2605' : '\u2606') + '</button></div>' +
    '<div class="post-body">' +
    '<div class="post-text">' + esc(p.body) + "</div>" +
    shopLabel +
    '<div class="post-foot">' + postFootHTML(key, p, inCart) + "</div>" +
    '<div class="post-time">🏷️ ' + esc(catName(p.category || "foods")) + " · " + esc(fmtTime(p.createdAt)) + "</div>" +
    "</div></div>";
}
/* Homepage feed: newest posts across ALL shops (after the product grid). */
async function drawFeed() {
  const box = document.getElementById("feedSection");
  if (!box) return;
  try {
    const { data, error } = await sb.from("posts")
      .select("*, shops(name_zh, name_my, name_en, approved)")
      .order("created_at", { ascending: false }).limit(20);
    if (error) throw error;
    const list = (data || []).filter(r => !r.shops || r.shops.approved !== false).slice(0, 10).map(r => {
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
  const foot = document.querySelector('.dish-card[data-key="' + key + '"] .dish-foot');
  if (foot) foot.innerHTML = dishFootHTML(d, Math.max(0, qty));
  else drawDishGrid();
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
  const feet = document.querySelectorAll('.post-card[data-key="' + key + '"] .post-foot');
  if (feet.length) feet.forEach(f => f.innerHTML = postFootHTML(key, d, Math.max(0, qty)));
  else { renderFeedPosts(); renderShopPosts(); }
  renderCartBar();
  window.scrollTo(0, y);
}

/* ---------- shop detail ---------- */
let shopCache = {};
function promptDlg(msg) { return new Promise((resolve) => {
  const ov = ensureModal();
  const msgEl = document.getElementById("modalMsg");
  msgEl.innerHTML = "";
  const label = document.createElement("div");
  label.textContent = msg;
  label.style.marginBottom = "10px";
  const inp = document.createElement("textarea");
  inp.rows = 3;
  inp.style.cssText = "width:100%;box-sizing:border-box;padding:10px;border:1px solid #ddd;border-radius:10px;font-size:15px;resize:vertical";
  msgEl.appendChild(label);
  msgEl.appendChild(inp);
  const btns = document.getElementById("modalBtns");
  btns.innerHTML = "";
  const bNo = document.createElement("button");
  bNo.className = "btn gray"; bNo.textContent = t("cancel");
  const bYes = document.createElement("button");
  bYes.className = "btn"; bYes.textContent = t("report");
  const done = (v) => { ov.classList.remove("open"); resolve(v); };
  bNo.onclick = () => done(null);
  bYes.onclick = () => done(inp.value.trim());
  btns.appendChild(bNo); btns.appendChild(bYes);
  ov.classList.add("open");
  setTimeout(() => inp.focus(), 100);
});}
async function openReport(reportedUid) {
  if (!currentUser || !reportedUid || reportedUid === currentUser.id) return;
  const reason = await promptDlg(t("reportReason"));
  if (reason === null) return;
  try {
    var r = await sb.from("reports").insert({ reporter_id: currentUser.id, reported_user_id: reportedUid, reason: reason || "" });
    if (r.error) throw r.error;
    toast("\u2705 " + t("reportSent"));
  } catch (e) { toast("\u26A0\uFE0F " + e.message); }
}
async function viewShop(id) {
  const app = document.getElementById("app");
  app.innerHTML = '<div class="center muted" style="padding:30px">…</div>';
  let s;
  try {
    const { data, error } = await sb.from("shops").select("*").eq("id", id).single();
    if (error || !data) { app.innerHTML = '<div class="card">' + esc(t("noShops")) + "</div>"; return; }
    s = mapShop(data);
    shopCache[id] = s;
    if (!s.approved) {
      const isOwner = currentUser && s.ownerUid === currentUser.id;
      const isAdmin = userDoc && userDoc.role === "admin";
      if (!isOwner && !isAdmin) {
        app.innerHTML = '<div class="card center muted">' + esc(t("shopPending")) + "</div>";
        return;
      }
    }
  } catch (e) { app.innerHTML = '<div class="card">⚠️ ' + esc(e.message) + "</div>"; return; }
  const addr = LANG === "zh" ? (s.address_zh || "") : (s.address_my || s.address_zh || "");
  app.innerHTML =
    '<p><a href="#/">' + esc(t("backToShops")) + "</a></p>" +
    '<div class="card"><h2 style="display:flex;align-items:center;gap:10px">' +
    (s.photo_url
      ? '<img src="' + esc(s.photo_url) + '" alt="" style="width:46px;height:46px;object-fit:cover;border-radius:50%;flex-shrink:0">'
      : esc(s.emoji || "🍜")) +
    "<span>" + esc(shopName(s)) +
    (s.sample ? '<span class="badge">' + esc(t("sampleBadge")) + "</span>" : "") + "</span>" +
    '<span class="badge" style="background:' + (s.isOpen ? "#e8f5e9;color:#2e7d32" : "#ffebee;color:#c62828") + '">' +
    (s.isOpen ? "🟢 " + esc(t("shopOpen")) : "🔴 " + esc(t("shopClosed"))) + "</span></h2>" +
    '<div class="profile-row"><span class="k">' + esc(t("ownerName")) + "</span><span>" + esc(s.ownerName || "-") + "</span></div>" +
    '<div class="profile-row"><span class="k">' + esc(t("address")) + "</span><span>" + esc(addr) + "</span></div>" +
    '<div class="profile-row"><span class="k">' + esc(t("phone")) + "</span><span><a href=\"tel:" + esc(s.phone || "") + "\">" + esc(s.phone || "-") + "</a></span></div>" +
    (currentUser ? '<div class="profile-row"><span class="k"><span class="tic">' + ICONS.flag + '</span></span><span><a href="javascript:void(0)" id="shop-report" style="color:var(--pink)">' + esc(t("report")) + '</a></span></div>' : "") +
    (s.wechatId ? '<div class="profile-row"><span class="k">' + esc(t("wechatId")) + '</span><span class="copyable">' + esc(s.wechatId) + "</span></div>" : "") +
    (s.deliveryFee > 0 ? '<div class="profile-row"><span class="k">🛵 ' + esc(t("deliveryFee")) + "</span><span>" + money(s.deliveryFee) + "</span></div>" : "") +
    "</div>" +
    '<div id="shopPosts"></div>' +
    '<div class="tabs">' +
    '<div class="tab' + (shopTab === "menu" ? " active" : "") + '" onclick="setShopTab(\'' + id + "','menu')\">🍜 " + esc(t("menu")) + "</div>" +
    '<div class="tab' + (shopTab === "chat" ? " active" : "") + '" onclick="setShopTab(\'' + id + "','chat')\">💬 " + esc(t("chat")) + "</div>" +
    "</div><div id=\"shopTabBody\"></div>";
  if (shopTab === "menu") drawMenuTab(id, s); else drawChatTab(id, s);
  var srBtn = document.getElementById("shop-report");
  if (srBtn) srBtn.onclick = function() { openReport(s.ownerUid); };
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
  const closedNotice = (!s.isOpen ? '<div class="notice" style="margin-bottom:10px">🔴 ' + esc(t("shopClosed")) + " — " + esc(t("shopClosedDesc")) + "</div>" : "");
  body.innerHTML = closedNotice + '<div class="card">' + items.map(it => {
    const key = id + "__" + it.id;
    const inCart = cart.items[key] ? cart.items[key].qty : 0;
    return '<div class="menu-item"><div class="info"><div class="nm">' + esc(itemName(it)) + ' <span data-rp="' + it.id + '"></span></div>' +
      '<div class="pr">' + money(it.price) + "</div></div>" +
      (s.isOpen === false ? '<div class="muted" style="font-size:12px">🔴</div>' :
      '<div class="qty-ctrl">' +
      (inCart > 0 ? '<button onclick="cartQty(\'' + id + "','" + it.id + "',-1)\">−</button><b>" + inCart + "</b>" : "") +
      '<button onclick="cartQty(\'' + id + "','" + it.id + "',1)\">＋</button>" +
      "</div>") + "</div>";
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
  html += '<div class="card"><h3>💰 ' + esc(t("payMethod")) + "</h3>" +
    '<div class="field"><select id="co-paymethod">' +
    '<option value="cod">' + esc(t("payCOD")) + "</option>" +
    '<option value="wavepay">WavePay</option>' +
    '<option value="kbzpay">KBZPay</option>' +
    "</select></div>" +
    '<div class="field" id="co-txnwrap" style="display:none"><label>' + esc(t("payTxn")) + '</label><input id="co-txn" placeholder="..."></div></div>';
  html += '<div class="card">' +
    '<div class="profile-row"><span>' + esc(t("subtotal")) + "</span><b>" + money(cartTotal()) + "</b></div>" +
    '<div class="profile-row"><span>🛵 ' + esc(t("deliveryFee")) + "</span><b>" + money(cartFeesTotal()) + "</b></div>" +
    '<div class="profile-row"><span>' + esc(t("total")) + "</span><b>" + money(cartGrandTotal()) + "</b></div>" +
    '<button class="btn" style="width:100%;margin-top:8px" onclick="checkoutAll()">' + esc(t("buyNow")) + "</button></div>";
  app.innerHTML = html;
  const pmSel = document.getElementById("co-paymethod");
  const txnWrap = document.getElementById("co-txnwrap");
  if (pmSel && txnWrap) pmSel.onchange = () => { txnWrap.style.display = pmSel.value === "cod" ? "none" : "block"; };
  // show vendor payment numbers
  (async () => {
    try {
      const sids = Object.keys(groups);
      const notes = [];
      for (const sid of sids) {
        let s = shopCache[sid];
        if (!s) {
          const r = await sb.from("shops").select("wavepay_number,kbzpay_number").eq("id", sid).single();
          if (r.data) s = { wavepay: r.data.wavepay_number || "", kbzpay: r.data.kbzpay_number || "" };
        }
        if (s && (s.wavepay || s.kbzpay)) {
          const lbl = (window._shops || []).find(x => x.id === sid);
          const nm = lbl ? shopName(lbl) : sid.slice(0, 8);
          notes.push("<div class='muted' style='margin-top:6px'><b>" + esc(nm) + "</b>" +
            (s.wavepay ? "<br>WavePay: <b>" + esc(s.wavepay) + "</b>" : "") +
            (s.kbzpay ? "<br>KBZPay: <b>" + esc(s.kbzpay) + "</b>" : "") + "</div>");
        }
      }
      if (notes.length && txnWrap) txnWrap.insertAdjacentHTML("beforebegin", notes.join(""));
    } catch (e) {}
  })();
}
function cartViewDelta(key, delta) {
  const cur = cart.items[key];
  if (!cur) return;
  // preserve checkout fields across the re-render
  const addrEl = document.getElementById("co-addr");
  const saved = addrEl ? {
    a: addrEl.value,
    p: document.getElementById("co-phone").value,
    n: document.getElementById("co-note").value,
    pm: (document.getElementById("co-paymethod") || {}).value || "cod",
    tx: (document.getElementById("co-txn") || {}).value || ""
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
        const pm2 = document.getElementById("co-paymethod");
        if (pm2) { pm2.value = saved.pm; pm2.dispatchEvent(new Event("change")); }
        const tx2 = document.getElementById("co-txn");
        if (tx2) tx2.value = saved.tx;
      }
    }
  });
}
async function checkoutAll() {
  if (needLogin()) return;
  if (window._checkingOut) return;
  window._checkingOut = true;
  try {
  const groups = {};
  Object.values(cart.items).forEach(it => { (groups[it.shopId] = groups[it.shopId] || []).push(it); });
  const shopIds = Object.keys(groups);
  if (!shopIds.length) { window._checkingOut = false; return; }
  const addr = (document.getElementById("co-addr").value || "").trim();
  const phone = (document.getElementById("co-phone").value || "").trim();
  const note = (document.getElementById("co-note").value || "").trim();
  const payMethod = (document.getElementById("co-paymethod") || {}).value || "cod";
  const payTxn = ((document.getElementById("co-txn") || {}).value || "").trim();
  if (!addr || !phone) { toast("⚠️ " + t("fillAddressPhone")); window._checkingOut = false; return; }
  // always re-fetch fresh shop status + payment numbers (cache may be stale)
  const freshShops = {};
  for (const sid of shopIds) {
    try {
      const { data } = await sb.from("shops").select("id,is_open,name_zh,name_my,name_en,wavepay_number,kbzpay_number").eq("id", sid).single();
      if (data) { freshShops[sid] = mapShop(data); shopCache[sid] = freshShops[sid]; }
    } catch (e) {}
    if (!freshShops[sid]) freshShops[sid] = shopCache[sid] || (window._shops || []).find(s => s.id === sid);
  }
  // verify all shops are open
  for (const sid of shopIds) {
    const sh = freshShops[sid];
    if (sh && sh.isOpen === false) { toast("⚠️ " + shopName(sh) + ": " + t("shopClosed")); window._checkingOut = false; return; }
  }
  // validate shop has the selected mobile payment number
  if (payMethod === "wavepay" || payMethod === "kbzpay") {
    for (const sid of shopIds) {
      const sh = freshShops[sid];
      const num = payMethod === "wavepay" ? (sh && sh.wavepay) : (sh && sh.kbzpay);
      if (!num) { toast("⚠️ " + (sh ? shopName(sh) : "") + ": " + t("noPayNumber")); window._checkingOut = false; return; }
    }
    if (!payTxn) { toast("⚠️ " + t("fillTxn")); window._checkingOut = false; return; }
  }
  // re-validate items are still available (vendor may have marked sold-out)
  const allItemIds = [...new Set(Object.values(cart.items).map(it => it.itemId).filter(id => id && !String(id).startsWith("post_")))];
  if (allItemIds.length) {
    try {
      const { data } = await sb.from("menu_items").select("id,available").in("id", allItemIds);
      const availMap = {};
      (data || []).forEach(m => { availMap[m.id] = m.available !== false; });
      const soldOut = Object.values(cart.items).filter(it => {
        const id = it.itemId;
        return id && !String(id).startsWith("post_") && availMap[id] === false;
      });
      if (soldOut.length) {
        soldOut.forEach(it => {
          const k = Object.keys(cart.items).find(k => cart.items[k] === it);
          if (k) delete cart.items[k];
        });
        try { if (typeof drawCart === "function") drawCart(); } catch (err) {}
        try { if (typeof renderCartBar === "function") renderCartBar(); } catch (err) {}
        toast("⚠️ " + t("itemsDropped"));
        window._checkingOut = false;
        return;
      }
    } catch (e) {}
  }
  if (!(await confirmDlg(t("confirmOrder") + " · " + money(cartGrandTotal())))) { window._checkingOut = false; return; }
  const succeeded = [];
  try {
    for (const sid of shopIds) {
      const items = groups[sid].map(it => ({
        itemId: it.itemId, name_zh: it.name_zh, name_my: it.name_my, name_en: it.name_en,
        price: it.price, qty: it.qty
      }));
      await placeShopOrder(sid, items, { address: addr, phone: phone, note: note, payMethod: payMethod, payTxn: payTxn });
      succeeded.push(sid);
    }
    cart = { items: {} };
    cartFees = {};
    prettyToast("✅", t("orderSent"), "green");
    location.hash = "#/orders";
  } catch (e) {
    // order row may already exist even if post-insert steps failed -> don't reorder it
    if (e._orderId && e._shopId && !succeeded.includes(e._shopId)) succeeded.push(e._shopId);
    // remove only succeeded shops from cart, keep failed ones for retry
    succeeded.forEach(sid => {
      Object.keys(cart.items).forEach(k => {
        if (cart.items[k] && cart.items[k].shopId === sid) delete cart.items[k];
      });
      delete cartFees[sid];
    });
    try { if (typeof drawCart === "function") drawCart(); } catch (err) {}
    try { if (typeof renderCartBar === "function") renderCartBar(); } catch (err) {}
    toast("⚠️ " + e.message + (succeeded.length ? " (" + t("partialOrder") + ": " + succeeded.length + ")" : ""));
  }
  } finally { window._checkingOut = false; }
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
    payment_method: delivery.payMethod || "cod", payment_txn: delivery.payTxn || "",
    status: "pending", conversation_id: null
  }).select().single();
  if (oErr) throw oErr;
  try {
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
  } catch (e) { e._orderId = order.id; e._shopId = shopId; throw e; }
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
    customer_avatar_url: (userDoc && userDoc.avatarUrl) || null,
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
  const ch = sb.channel("chat-" + convId + "-" + Date.now())
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
    // fetch live posts for post-based items
    const postIds = [...new Set(o.items.map(it => String(it.itemId || "")).filter(id => id.startsWith("post_")).map(id => id.slice(5)))];
    const postMap = {};
    if (postIds.length) {
      try {
        const { data } = await sb.from("posts").select("*").in("id", postIds);
        (data || []).forEach(p => { postMap["post_" + p.id] = mapPost(p); });
      } catch (e) {}
    }
    const sh = shopRes.data ? mapShop(shopRes.data) : {};
    let added = 0, dropped = 0;
    for (const it of o.items) {
      const mid = String(it.itemId || "");
      const cur = mid.startsWith("post_") ? postMap[mid] : byId[it.itemId];
      if (!cur || cur.available === false) { dropped++; continue; }
      const key = o.shopId + "__" + it.itemId;
      const old = cart.items[key];
      const isPost = mid.startsWith("post_");
      cart.items[key] = {
        shopId: o.shopId, itemId: it.itemId, qty: (old ? old.qty : 0) + (it.qty || 1),
        name_zh: isPost ? cur.body : cur.name_zh, name_my: isPost ? cur.body : cur.name_my, name_en: isPost ? cur.body : cur.name_en,
        price: Number(isPost ? cur.price : cur.price_yuan) || 0, photoUrl: isPost ? cur.photoUrl : cur.photo_url, emoji: isPost ? "📢" : cur.emoji,
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
    // fetch driver info for delivering orders
    const drivers = {};
    const driverIds = [...new Set(list.filter(o => o.driverId && o.status === "delivering").map(o => o.driverId))];
    if (driverIds.length) {
      try {
        const { data: dd } = await sb.from("users").select("id,first_name,phone").in("id", driverIds);
        (dd || []).forEach(d => { drivers[d.id] = d; });
      } catch (e) {}
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
      o._driver = drivers[o.driverId] || null;
      window._orderChatInfo[o.id] = { shopId: o.shopId, vendorUid: o.vendorUid, title: shopName(sh) };
      if (o.convId) window._convToOrder[o.convId] = o.id;
      window._orderList[o.id] = o;
      return orderCard(o, sh, false);
    }).join("");
    box.querySelectorAll("[data-reorder]").forEach(b => b.onclick = () => reorder(b.getAttribute("data-reorder")));
    box.querySelectorAll("[data-rateorder]").forEach(b => b.onclick = () => rateSheet(b.getAttribute("data-rateorder")));
    box.querySelectorAll("[data-confirmrecv]").forEach(b => b.onclick = () => confirmReceived(b.getAttribute("data-confirmrecv")));
    snapshotOrderSeen(list);
      // realtime: vendor replies -> bump the chat badge live (ping unless its chatbox is open)
      if (convIds.length) {
        const mch = sb.channel("my-msgs-" + currentUser.id + "-" + Date.now())
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
  const ch = sb.channel("my-orders-" + currentUser.id + "-" + Date.now())
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
async function confirmReceived(orderId) {
  if (!(await confirmDlg(t("confirmReceived") + "?"))) return;
  const r = await sb.from("orders").update({ status: "done" }).eq("id", orderId);
  if (r.error) toast("\u26A0\uFE0F " + r.error.message); else viewOrders();
}

function orderCard(o, shop, isVendor) {
  const items = (o.items || []).map(it =>
    "<div>" + esc(itemName(it)) +
    " × " + it.qty + " · " + money(it.price * it.qty) + "</div>").join("");
  let btns = "";
  if (isVendor) {
    if (o.status === "pending") btns += '<button class="btn small green" onclick="setStatus(\'' + o.id + "','" + o.convId + "','accepted')\">" + esc(t("acceptOrder")) + "</button>";
    if (o.status === "accepted") btns += '<button class="btn small" onclick="setStatus(\'' + o.id + "','" + o.convId + "','ready')\">" + esc(t("markReady")) + "</button>";
    if (o.status === "delivering") btns += '<button class="btn small green" onclick="setStatus(\'' + o.id + "','" + o.convId + "','done')\">" + esc(t("completeOrder")) + "</button>";
    if (o.status === "ready") btns += '<button class="btn small" onclick="setStatus(\'' + o.id + "','" + o.convId + "','delivering')\">" + esc(t("markDelivering")) + "</button>";
    if (o.status === "pending" || o.status === "accepted")
      btns += '<button class="btn small gray" onclick="setStatus(\'' + o.id + "','" + o.convId + "','cancelled')\">" + esc(t("cancelOrder")) + "</button>";
    if (o.status === "done" || o.status === "cancelled")
      btns += '<button class="btn small gray" data-varch="' + o.id + '">' + esc(t("del")) + "</button>";
  } else {
    const uc = ((window._unreadByConv || {})[o.convId] || 0);
    btns += '<button class="btn small" data-chatbtn="' + o.id + '" onclick="toggleOrderChat(\'' + o.id + "')\">" + "💬 " + esc(t("chat")) + (uc ? ' <span class="ubadge">' + uc + "</span>" : "") + "</button>";
    if (o.status === "pending" || o.status === "accepted")
      btns += '<button class="btn small gray" onclick="cancelMyOrder(\'' + o.id + "')\">" + esc(t("cancelOrder")) + "</button>";
    btns += '<button class="btn small" data-reorder="' + o.id + '">🔁 ' + esc(t("reorder")) + "</button>";
    if (o.status === "delivering")
      btns += '<button class="btn small green" data-confirmrecv="' + o.id + '">' + esc(t("confirmReceived")) + "</button>";
    if (o.status === "done")
      btns += '<button class="btn small" data-rateorder="' + o.id + '">⭐ ' + esc(t("rateIt")) + "</button>";
  }
  const itemCount = (o.items || []).reduce((a, it) => a + (it.qty || 0), 0);
  const isOpen = (window._openOrders || {}).has ? window._openOrders.has(o.id) : false;
  const newCustWarn = (isVendor && o.status === "pending" && window._newCust && window._newCust[o.customerUid])
    ? '<div class="notice" style="margin:0 0 8px">' + esc(t("newCustomerWarn")) + "</div>" : "";
  return newCustWarn + '<div class="card order-card2' + (isOpen ? " open" : "") + '" data-oid="' + o.id + '">' +
    '<div class="oc-head" onclick="toggleOrderCard(this)">' +
    '<div style="flex:1;min-width:0"><b>' + esc(shop ? shopName(shop) : o.shopId) + "</b>" +
    '<div class="muted">' + esc(fmtTime(o.createdAt)) + " · " + itemCount + " · " + money(o.total) + "</div></div>" +
    '<span class="status ' + o.status + '">' + esc(t("status_" + o.status)) + "</span>" +
    '<span class="oc-chev">\u25BC</span></div>' +
    '<div class="oc-details">' +
    '<div style="margin:6px 0">' + items + "</div>" +
    ((o.deliveryAddress || o.customerPhone)
      ? '<div class="delivery-info">📍 ' + esc(o.deliveryAddress || "") +
        (o.customerPhone ? "<br>📞 " + esc(o.customerPhone) : "") +
        (o.note ? "<br>📝 " + esc(o.note) : "") + "</div>" : "") +
    (o._driver && o.status === "delivering"
      ? '<div class="delivery-info" style="background:#e8f5e9">🛵 ' + esc(t("yourDriver")) + ": <b>" + esc(o._driver.first_name || "") + "</b>" +
        (o._driver.phone ? ' · <a href="tel:' + esc(o._driver.phone) + '">' + esc(o._driver.phone) + "</a>" : "") + "</div>" : "") +
    (o.payMethod && o.payMethod !== "cod"
      ? '<div class="delivery-info">💰 ' + esc(o.payMethod === "wavepay" ? "WavePay" : "KBZPay") +
        (o.payTxn ? " · " + esc(o.payTxn) : "") + "</div>" : "") +
    (o.deliveryFee > 0
      ? '<div class="profile-row"><span>🛵 ' + esc(t("deliveryFee")) + "</span><b>" + money(o.deliveryFee) + "</b></div>" : "") +
    "<b>" + esc(t("total")) + ": " + money(o.total) + "</b>" +
    (btns ? '<div class="rowbtns">' + btns + "</div>" : "") +
    (isVendor ? "" : '<div id="oc-' + o.id + '" style="margin-top:8px"></div>') + "</div></div>";
}
function toggleOrderCard(headEl) {
  const card = headEl && headEl.closest ? headEl.closest(".order-card2") : null;
  if (!card) return;
  const oid = card.getAttribute("data-oid");
  window._openOrders = window._openOrders || new Set();
  if (window._openOrders.has(oid)) { window._openOrders.delete(oid); card.classList.remove("open"); }
  else { window._openOrders.add(oid); card.classList.add("open"); }
}
async function setStatus(orderId, convId, status) {
  try {
    const { error } = await sb.from("orders").update({ status: status }).eq("id", orderId);
    if (error) throw error;
    if (convId && convId !== "null" && convId !== "undefined") {
      try {
        await sb.from("messages").insert({
          conversation_id: convId, sender_id: currentUser.id,
          sender_role: (userDoc && userDoc.role) || "vendor",
          kind: "text", body: "📦 " + t("status_" + status)
        });
      } catch (e) {}
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
/* Standalone vendor orders page (tap-bar 📦): orders only, no center header. */
async function viewVendorOrdersPage() {
  const app = document.getElementById("app");
  app.innerHTML = '<h2>📦 ' + esc(t("tabOrders")) + '</h2><div id="vtab"></div>';
  await drawVendorOrders();
}

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
    (!myShop.approved ? '<div class="notice">\u23F3 ' + esc(t("shopPendingVendor")) + "</div>" : "") +
    '<div class="card" style="display:flex;gap:20px;position:relative">' +
    '<button class="btn small" style="position:absolute;top:8px;right:8px;padding:6px 10px" onclick="editShopInfo()">✏️</button>' +
    '<div style="position:absolute;bottom:8px;right:8px"><button class="btn small ' + (myShop.isOpen ? "green" : "gray") + '" onclick="toggleShopOpen()">' + (myShop.isOpen ? "🟢 " + esc(t("shopOpen")) : "🔴 " + esc(t("shopClosed"))) + "</button></div>" +
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
    '<div class="tab' + (vendorTab === "posts" ? " active" : "") + '" onclick="setVendorTab(\'posts\')">📢 ' + esc(t("posts")) + "</div>" +
    "</div><div id=\"vtab\"></div>";
  if (vendorTab === "chats" || vendorTab === "orders") vendorTab = "menu";
  if (vendorTab === "info") drawVendorInfo();
  if (vendorTab === "menu") drawVendorMenu();
  if (vendorTab === "posts") drawVendorPosts();
}
function setVendorTab(tab) { vendorTab = tab; viewVendor(); }
function drawVendorInfo() {
  const box = document.getElementById("vtab");
  box.innerHTML = showShopForm ? shopForm(myShop) : "";
}
async function toggleShopOpen() {
  if (!myShop) return;
  const newVal = !myShop.isOpen;
  const { error } = await sb.from("shops").update({ is_open: newVal }).eq("id", myShop.id);
  if (error) { toast("⚠️ " + error.message); return; }
  myShop.isOpen = newVal;
  viewVendor();
  prettyToast(newVal ? "🟢" : "🔴", t(newVal ? "shopOpen" : "shopClosed"), newVal ? "green" : "red");
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
    '<div class="field"><label>WavePay</label><input id="s-wavepay" value="' + v("wavepay") + '" placeholder="09..."></div>' +
    '<div class="field"><label>KBZPay</label><input id="s-kbzpay" value="' + v("kbzpay") + '" placeholder="09..."></div>' +
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
    wavepay_number: document.getElementById("s-wavepay").value.trim(),
    kbzpay_number: document.getElementById("s-kbzpay").value.trim(),
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
        '<div class="field"><input id="m-zh" placeholder="' + esc(t("itemName")) + ' (中文)"></div>' +
        '<div class="field"><input id="m-my" placeholder="' + esc(t("itemName")) + ' (မြန်မာ)"></div>' +
        '<div class="field"><input id="m-en" placeholder="' + esc(t("itemName")) + ' (English)"></div>' +
        '<div class="field"><input id="m-price" type="number" min="0" placeholder="' + esc(t("priceYuan")) + '"></div>' +
        '<div class="field"><input id="m-photo" placeholder="' + esc(t("photoUrl")) + '"></div>' +
        '<button class="btn" style="width:100%" onclick="addMenuItem()">' + esc(t("add")) + "</button></div>"
      : "") +
    '<div class="card">' + (items.length ? items.map(it =>
      '<div class="menu-item"><div class="info"><div class="nm">' + esc(itemName(it)) + ' <span data-rp="' + it.id + '"></span></div>' +
      '<div class="pr">' + money(it.price) + "</div></div>" +
      '<div style="display:flex;gap:6px;align-items:center">' +
      '<button class="btn small ' + (it.available !== false ? "green" : "gray") + '" onclick="toggleItemAvail(\'' + it.id + "'," + (it.available !== false ? "false" : "true") + ')">' + esc(t(it.available !== false ? "soldOut" : "inStock")) + "</button>" +
      '<button class="btn small gray" onclick="delMenuItem(\'' + it.id + "')\">" + esc(t("del")) + "</button></div></div>"
    ).join("") : '<div class="muted center">—</div>') + "</div>";
  loadRateBadges(box);
}
async function addMenuItem() {
  const nzh = document.getElementById("m-zh").value.trim();
  const nmy = (document.getElementById("m-my") || {}).value.trim() || "";
  const nen = (document.getElementById("m-en") || {}).value.trim() || "";
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
async function toggleItemAvail(itemId, avail) {
  const { error } = await sb.from("menu_items").update({ available: avail }).eq("id", itemId);
  if (error) toast("⚠️ " + error.message);
  else drawVendorMenu();
}
async function delMenuItem(itemId) {
  if (!(await confirmDlg(t("confirmDelete")))) return;
  try {
    const { error } = await sb.from("menu_items").delete().eq("id", itemId);
    if (error) throw error;
    drawVendorMenu();
  } catch (e) { toast("⚠️ " + e.message); }
}
/* Long-press (600ms) helper: fires fn once; suppresses the tap that follows. */
function addLongPress(el, fn) {
  let t = null;
  const start = () => {
    if (t) return;
    t = setTimeout(() => { t = null; el.dataset.lp = "1"; fn(); }, 600);
  };
  const cancel = () => { if (t) { clearTimeout(t); t = null; } };
  el.addEventListener("touchstart", start, { passive: true });
  el.addEventListener("touchend", cancel);
  el.addEventListener("touchmove", cancel);
  el.addEventListener("mousedown", start);
  el.addEventListener("mouseup", cancel);
  el.addEventListener("mouseleave", cancel);
}
/* Delete a whole conversation (its messages cascade-delete too). */
async function clearConversation(convId) {
  if (!convId) return;
  if (!(await confirmDlg(t("clearChatConfirm")))) return;
  try {
    const { error } = await sb.from("conversations").delete().eq("id", convId);
    if (error) throw error;
    if (window._unreadByConv) delete window._unreadByConv[convId];
    toast("\uD83D\uDDD1\uFE0F " + t("chatCleared"));
    if (typeof renderAll === "function") renderAll();
  } catch (e) { toast("\u26A0\uFE0F " + (e.message || e)); }
}

/* ---------- full-page chat (Messenger/TikTok style) ---------- */
async function viewChatPage(convId) {
  if (needLogin()) return;
  if (!convId || !/^[0-9a-f-]{36}$/i.test(convId)) { location.hash = "#/chats"; return; }
  const app = document.getElementById("app");
  app.innerHTML = '<div class="chat-page"><div class="center muted">…</div></div>';
  window._openChatsView = convId;
  try {
    const { data: conv } = await sb.from("conversations").select("*").eq("id", convId).single();
    if (!conv || (conv.customer_id !== currentUser.id && conv.vendor_id !== currentUser.id)) {
      location.hash = "#/chats"; return;
    }
    let nm = conv.customer_name || "…";
    let avatarHtml = '<div class="shop-emoji">👤</div>';
    if (conv.customer_id === currentUser.id) {
      avatarHtml = '<div class="shop-emoji">🏪</div>';
      try {
        const { data: sh } = await sb.from("shops").select("name_zh,name_my,name_en,photo_url").eq("id", conv.shop_id).single();
        if (sh) nm = shopName(mapShop(sh));
        if (sh && sh.photo_url) avatarHtml = '<img class="shop-thumb" src="' + esc(sh.photo_url) + '" alt="" loading="lazy">';
      } catch (e) {}
    } else if (conv.customer_avatar_url) {
      avatarHtml = '<img class="shop-thumb" src="' + esc(conv.customer_avatar_url) + '" alt="" loading="lazy">';
    }
    const page = app.querySelector(".chat-page");
    page.innerHTML =
      '<div class="chead"><button class="back" id="chat-back">‹</button>' +
      avatarHtml + '<div class="who" style="flex:1">' + esc(nm) + "</div>" +
      '<button class="btn small gray" id="chat-report" style="padding:6px 8px"><span class="tic">' + ICONS.flag + '</span></button>' + "</div>" +
      '<div id="chat-page-body" style="display:flex;flex-direction:column;flex:1;min-height:0"></div>';
    document.getElementById("chat-back").onclick = () => { location.hash = "#/chats"; };
    document.getElementById("chat-report").onclick = () => openReport(conv.customer_id === currentUser.id ? conv.vendor_id : conv.customer_id);
    mountChat(document.getElementById("chat-page-body"), convId, "");
    syncChatTabBadge();
  } catch (e) {
    app.innerHTML = '<div class="card center">⚠️ ' + esc(e.message || e) + "</div>";
  }
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
      let shopPhotos = {};
      if (!isV) {
        const sids = [...new Set(list.map(c => c.shopId).filter(Boolean))];
        if (sids.length) {
          const { data: shops } = await sb.from("shops").select("id,name_zh,name_my,name_en,photo_url").in("id", sids);
          (shops || []).forEach(x => { names[x.id] = shopName(mapShop(x)); if (x.photo_url) shopPhotos[x.id] = x.photo_url; });
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
        const avatar = (!isV && shopPhotos[c.shopId])
          ? '<img class="shop-thumb" src="' + esc(shopPhotos[c.shopId]) + '" alt="" loading="lazy">'
          : (isV && c.customerAvatarUrl
            ? '<img class="shop-thumb" src="' + esc(c.customerAvatarUrl) + '" alt="" loading="lazy">'
            : '<div class="shop-emoji">' + (isV ? "👤" : "🏪") + "</div>");
        return '<div class="card shop-card" data-conv="' + c.id + '" data-nm="' + esc(nm) + '">' + avatar +
          '<div style="flex:1"><h3>' + esc(nm) +
          (unread[c.id] ? ' <span class="ubadge">' + unread[c.id] + "</span>" : "") + "</h3>" +
          '<div class="meta">' + esc(fmtTime(c.lastMessageAt)) + "</div></div></div>";
      }).join("");
      listBox.querySelectorAll("[data-conv]").forEach(el => {
        el.onclick = () => {
          if (el.dataset.lp) { el.dataset.lp = ""; return; }
          const b = el.querySelector(".ubadge");
          const n = b ? Number(b.textContent) || 0 : 0;
          if (b) b.remove();
          if (n) window._totalUnread = Math.max(0, (window._totalUnread || 0) - n);
          const cid = el.getAttribute("data-conv");
          location.hash = "#/chat/" + cid;
        };
        addLongPress(el, () => clearConversation(el.getAttribute("data-conv")));
      });
    } catch (e) { listBox.innerHTML = "\u26A0\uFE0F " + esc(e.message); }
  };
  await render();

  const ch = sb.channel("chats-page-" + currentUser.id + "-" + Date.now())
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
  const ch = sb.channel("vendor-chats-" + currentUser.id + "-" + Date.now())
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
    '<div class="card shop-card" data-conv="' + c.id + '">' +
    (c.customerAvatarUrl
      ? '<img class="shop-thumb" src="' + esc(c.customerAvatarUrl) + '" alt="" loading="lazy">'
      : '<div class="shop-emoji">👤</div>') +
    '<div style="flex:1"><h3>' + esc(c.customerName || "\u2026") +
    (unread[c.id] ? ' <span class="ubadge">' + unread[c.id] + "</span>" : "") + "</h3>" +
    '<div class="meta">' + esc(fmtTime(c.lastMessageAt)) + "</div></div></div>").join("");
  listBox.querySelectorAll("[data-conv]").forEach(el => {
    el.onclick = () => {
      if (el.dataset.lp) { el.dataset.lp = ""; return; }
      location.hash = "#/chat/" + el.getAttribute("data-conv");
    };
    addLongPress(el, () => clearConversation(el.getAttribute("data-conv")));
  });
  return list.map(c => c.id);
}
async function drawVendorOrders(skipChannel) {
  const box = document.getElementById("vtab");
  if (!box) return;
  // auto-cancel stale pending orders (>30 min, vendor never responded)
  try {
    const cutoff = new Date(Date.now() - 30 * 60000).toISOString();
    await sb.from("orders").update({ status: "cancelled" })
      .eq("vendor_id", currentUser.id).eq("status", "pending").lt("created_at", cutoff);
  } catch (e) {}
  // realtime first: vendor hears about new orders even with an empty list
  if (!skipChannel) {
  try {
    const ch = sb.channel("vendor-orders-" + currentUser.id + "-" + Date.now())
      .on("postgres_changes",
        { event: "*", schema: "public", table: "orders", filter: "vendor_id=eq." + currentUser.id },
        (payload) => {
          if (payload && payload.eventType === "INSERT") notifyPing("🔔 " + t("newOrder"));
          if (payload && payload.eventType === "UPDATE" && payload.new && payload.new.status === "cancelled")
            notifyPing("⚠️ " + t("orderCancelled"));
          refreshOrderBadge(true);
          drawVendorOrders(true);
        })
      .subscribe();
    unsubs.push(ch);
  } catch (e) {}
  }
  box.innerHTML = '<div class="center muted">…</div>';
  const [allRes, listRes] = await Promise.all([
    sb.from("orders").select("id,total_yuan,created_at").eq("vendor_id", currentUser.id).eq("status", "done"),
    sb.from("orders").select("*").eq("vendor_id", currentUser.id).eq("vendor_archived", false).order("created_at", { ascending: false })
  ]);
  if (listRes.error) { box.innerHTML = "⚠️ " + esc(listRes.error.message); return; }
  const list = (listRes.data || []).map(mapOrder);
  if (!list.length && !(allRes.data || []).length) { box.innerHTML = '<div class="card center muted">' + esc(t("noOrders")) + "</div>"; return; }
  // sales summary (from ALL done orders, archived included)
  const allDone = allRes.data || [];
  const totalSales = allDone.reduce((a, o) => a + (Number(o.total_yuan) || 0), 0);
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  const yangonDay = (iso) => { try { return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }); } catch (e) { return ""; } };
  const todaySales = allDone.filter(o => yangonDay(o.created_at) === todayStr)
    .reduce((a, o) => a + (Number(o.total_yuan) || 0), 0);
  const salesHtml = '<div class="card" style="background:#e8f5e9;text-align:center">' +
    '<div style="display:flex;justify-content:space-around">' +
    '<div><div style="font-size:12px;color:#666">' + esc(t("todaySales")) + '</div><div style="font-size:18px;font-weight:800;color:#2e7d32">' + money(todaySales) + "</div></div>" +
    '<div><div style="font-size:12px;color:#666">' + esc(t("totalSales")) + '</div><div style="font-size:18px;font-weight:800;color:#2e7d32">' + money(totalSales) + "</div></div>" +
    '<div><div style="font-size:12px;color:#666">' + esc(t("totalOrders")) + '</div><div style="font-size:18px;font-weight:800">' + allDone.length + "</div></div>" +
    "</div></div>";
  // flag customers with no completed orders yet
  window._newCust = {};
  try {
    const pcids = [...new Set(list.filter(o => o.status === "pending").map(o => o.customerUid).filter(Boolean))];
    if (pcids.length) {
      const dr = await sb.from("orders").select("customer_id").eq("vendor_id", currentUser.id).eq("status", "done").in("customer_id", pcids);
      const hasDone = new Set((dr.data || []).map(r => r.customer_id));
      pcids.forEach(id => { if (!hasDone.has(id)) window._newCust[id] = true; });
    }
  } catch (e) {}
  box.innerHTML = salesHtml + list.map(o =>
    orderCard(o, { name_zh: t("orderFrom") + ": " + (o.customerName || "?") + (o.customerEmail ? " (" + o.customerEmail + ")" : ""), name_my: "", name_en: "" }, true)
  ).join("");
  box.querySelectorAll("[data-varch]").forEach(b => b.onclick = () => archiveVendorOrder(b.getAttribute("data-varch")));
}

async function archiveVendorOrder(orderId) {
  if (!(await confirmDlg(t("del") + "?"))) return;
  const { error } = await sb.from("orders").update({ vendor_archived: true }).eq("id", orderId).eq("vendor_id", currentUser.id);
  if (error) toast("⚠️ " + error.message);
  else drawVendorOrders(true);
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
/* One silent global watcher: any new/changed order refreshes the orders
 * tab badge wherever I am in the app (vendor also gets a ping on new orders). */
let _goCh = null;
function ensureGlobalOrderWatch() {
  const uid = currentUser && currentUser.id;
  if (!uid || typeof sb === "undefined") return;
  if (_goCh && _goCh._uid === uid) return;
  if (_goCh) { try { sb.removeChannel(_goCh); } catch (e) {} _goCh = null; }
  const role = (userDoc && userDoc.role) || "customer";
  const isV = role === "vendor" || role === "admin";
  const col = isV ? "vendor_id" : "customer_id";
  const ch = sb.channel("global-orders-" + uid + "-" + Date.now())
    .on("postgres_changes",
      { event: "*", schema: "public", table: "orders", filter: col + "=eq." + uid },
      (payload) => {
        if (payload && payload.eventType === "INSERT" && isV &&
            location.hash !== "#/vendor/orders") {
          try { notifyPing("\uD83D\uDD14 " + t("newOrder")); } catch (e) {}
        }
        refreshOrderBadge(true);
      })
    .subscribe();
  ch._uid = uid;
  _goCh = ch;
  window._goCh = ch;
  ensureDriverOrderWatch();
}
/* Driver: ping when a new "ready" order appears (vendor just marked ready). */
function ensureDriverOrderWatch() {
  const uid = currentUser && currentUser.id;
  if (!uid || typeof sb === "undefined") return;
  const role = (userDoc && userDoc.role) || "customer";
  if (role !== "driver" || !userDoc.driverApproved) {
    if (window._drvCh) { try { sb.removeChannel(window._drvCh); } catch (e) {} window._drvCh = null; }
    if (window._drvBc) { try { sb.removeChannel(window._drvBc); } catch (e) {} window._drvBc = null; }
    return;
  }
  if (window._drvCh && window._drvCh._uid === uid) return;
  if (window._drvCh) { try { sb.removeChannel(window._drvCh); } catch (e) {} window._drvCh = null; }
  const ch = sb.channel("driver-orders-" + uid + "-" + Date.now())
    .on("postgres_changes",
      { event: "*", schema: "public", table: "orders" },
      (payload) => {
        const o = (payload && payload.new) || {};
        // new ready order -> ping
        if (payload.eventType === "INSERT" && o.status === "ready" && !o.driver_id) {
          if (location.hash !== "#/driver") {
            try { notifyPing(t("newDelivery")); } catch (e) {}
          } else {
            drawDriverTab(window._driverTab || 0);
          }
          return;
        }
        // any order update -> refresh (broadcast handles instant disappear on claim)
        if (payload.eventType === "UPDATE") {
          // vendor marked ready via update -> ping if we haven't seen it
          if (o.status === "ready" && !o.driver_id && o.id) {
            window._seenReady = window._seenReady || {};
            if (!window._seenReady[o.id]) {
              window._seenReady[o.id] = true;
              if (location.hash !== "#/driver") {
                try { notifyPing(t("newDelivery")); } catch (e) {}
              }
            }
          }
          if (location.hash === "#/driver") {
            if (window._drvRefreshT) clearTimeout(window._drvRefreshT);
            window._drvRefreshT = setTimeout(() => drawDriverTab(window._driverTab || 0), 800);
          }
          refreshOrderBadge(true);
        }
      })
    .subscribe();
  ch._uid = uid;
  window._drvCh = ch;
  // listen for claims by other drivers -> refresh immediately
  try {
    if (window._drvBc) { try { sb.removeChannel(window._drvBc); } catch (e) {} }
    const bc = sb.channel("driver-broadcast");
    bc.on("broadcast", { event: "claimed" }, (payload) => {
      if (payload && payload.payload && payload.payload.orderId) {
        if (location.hash === "#/driver") drawDriverTab(window._driverTab || 0);
        refreshOrderBadge(true);
      }
    }).subscribe();
    window._drvBc = bc;
  } catch (e) {}
}
/* Orders tab badge: vendor = pending orders needing action;
 * customer = my orders whose status changed since I last opened Orders. */
async function refreshOrderBadge(force) {
  if (!currentUser) { window._newOrderCount = 0; syncOrderTabBadge(); return 0; }
  const now = Date.now();
  if (!force && window._obAt && now - window._obAt < 5000) { syncOrderTabBadge(); return window._newOrderCount || 0; }
  window._obAt = now;
  let n = 0;
  try {
    const role = (userDoc && userDoc.role) || "customer";
    if (role === "vendor" || role === "admin") {
      const r = await sb.from("orders").select("id", { count: "exact", head: true })
        .eq("vendor_id", currentUser.id).eq("status", "pending");
      n = r.count || 0;
    } else if (role === "driver") {
      const r = await sb.from("orders").select("id", { count: "exact", head: true })
        .eq("status", "ready").is("driver_id", null);
      n = r.count || 0;
    } else {
      const r = await sb.from("orders").select("id,status").eq("customer_id", currentUser.id);
      let seen = {};
      try { seen = JSON.parse(localStorage.getItem("ml_order_seen") || "{}"); } catch (e) {}
      for (const o of (r.data || [])) {
        if (seen[o.id] && seen[o.id] !== o.status) n++;
      }
    }
  } catch (e) {}
  window._newOrderCount = n;
  syncOrderTabBadge();
  return n;
}
function syncOrderTabBadge() {
  const n = window._newOrderCount || 0;
  for (const h of ["#/orders", "#/vendor/orders"]) {
    const btn = document.querySelector('#tapbar [data-h="' + h + '"]');
    if (!btn) continue;
    let b = btn.querySelector(".cbadge");
    if (n > 0) {
      if (!b) { b = document.createElement("span"); b.className = "cbadge"; btn.appendChild(b); }
      b.textContent = n > 99 ? "99+" : n;
    } else if (b) b.remove();
  }
}
function snapshotOrderSeen(list) {
  try {
    const m = {};
    for (const o of (list || [])) m[o.id] = o.status;
    localStorage.setItem("ml_order_seen", JSON.stringify(m));
  } catch (e) {}
  window._newOrderCount = 0;
  syncOrderTabBadge();
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
  const ch = sb.channel("global-chats-" + uid + "-" + Date.now())
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
/* Crisp SVG tap-bar icons (stroke style, inherit pink/gray via currentColor) */
const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg>',
  cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96 12 12.01l8.73-5.05"/><path d="M12 22.08V12"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
  store: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/></svg>',
  wrench: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>'
};
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
  const isD = role === "driver";
  const tu = window._totalUnread || 0;
  const chatTab = { ic: ICONS.chat, label: t("chat"), hash: "#/chats", active: h === "#/chats" || h.startsWith("#/chat/"), badge: tu };
  let tabs;
  if (isD) {
    tabs = [
      { ic: ICONS.box, label: t("deliveries"), hash: "#/driver", active: h === "#/driver" || !h.startsWith("#/"), badge: window._newOrderCount || 0 },
      { ic: ICONS.user, label: t("profile"), hash: "#/profile", active: h === "#/profile" }
    ];
  } else if (isV) {
    tabs = [
      { ic: ICONS.home, label: t("home"), hash: "#/", active: h === "#/" || !h.startsWith("#/") },
      chatTab,
      { ic: ICONS.box, label: t("tabOrders"), hash: "#/vendor/orders", active: h === "#/vendor/orders", badge: window._newOrderCount || 0 },
      { ic: ICONS.store, label: t("vendorCenter"), hash: "#/vendor", active: h === "#/vendor" }
    ];
    if (role === "admin")
      tabs.push({ ic: ICONS.wrench, label: t("adminPanel"), hash: "#/admin", active: h === "#/admin" });
  } else {
    tabs = [
      { ic: ICONS.home, label: t("home"), hash: "#/", active: h === "#/" || !h.startsWith("#/") },
      { ic: ICONS.cart, label: t("cart"), hash: "#/cart", active: h === "#/cart", badge: cc }
    ];
    if (currentUser) tabs.push({ ic: ICONS.box, label: t("orders"), hash: "#/orders", active: h === "#/orders", badge: window._newOrderCount || 0 });
    tabs.push(chatTab);
  }
  refreshTotalUnread(false);
  refreshOrderBadge(false);
  // Avoid rebuilding the bar when nothing changed (prevents visible flicker).
  const sig = tabs.map(tb => tb.hash + "|" + tb.label + "|" + (tb.active ? 1 : 0) + "|" + (tb.badge || 0)).join(";");
  if (bar.dataset.sig === sig) { syncChatTabBadge(); syncOrderTabBadge(); return; }
  bar.dataset.sig = sig;
  bar.innerHTML = tabs.map(tb =>
    '<button class="' + (tb.active ? "active" : "") + '" data-h="' + tb.hash + '">' +
    '<span class="ic">' + tb.ic + "</span><span>" + esc(tb.label) + "</span>" +
    (tb.badge ? '<span class="cbadge">' + tb.badge + "</span>" : "") + "</button>").join("");
  bar.querySelectorAll("button").forEach(b =>
    b.onclick = () => { location.hash = b.getAttribute("data-h"); });
  syncChatTabBadge();
  syncOrderTabBadge();
}

/* ---------- driver ---------- */
async function viewDriver() {
  if (needLogin()) return;
  const app = document.getElementById("app");
  if (!userDoc || userDoc.role !== "driver") {
    app.innerHTML = '<div class="notice">' + esc(t(!userDoc ? "loginFirst" : "driverOnly")) + "</div>";
    return;
  }
  if (!userDoc.driverApproved) {
    app.innerHTML = '<div class="notice">' + esc(t("driverPending")) + "</div>";
    return;
  }
  const dt = window._driverTab || 0;
  app.innerHTML = "<h2>" + esc(t("deliveries")) + '</h2><div class="tabs">' +
    '<div class="tab' + (dt === 0 ? " active" : "") + '" id="dtab-avail" onclick="setDriverTab(0)">' + esc(t("availableOrders")) + "</div>" +
    '<div class="tab' + (dt === 1 ? " active" : "") + '" id="dtab-mine" onclick="setDriverTab(1)">' + esc(t("myDeliveries")) + "</div>" +
    '<div class="tab' + (dt === 2 ? " active" : "") + '" id="dtab-hist" onclick="setDriverTab(2)">' + esc(t("history")) + "</div>" +
    '</div><div id="dbody"><div class="center muted">…</div></div>';
  drawDriverTab(dt);
}
function setDriverTab(i) {
  window._driverTab = i;
  ["dtab-avail", "dtab-mine", "dtab-hist"].forEach((id, j) => {
    const el = document.getElementById(id);
    if (el) el.className = "tab" + (i === j ? " active" : "");
  });
  drawDriverTab(i);
}
async function drawDriverTab(i) {
  const box = document.getElementById("dbody");
  if (!box) return;
  box.innerHTML = '<div class="center muted">…</div>';
  try {
    let q = sb.from("orders").select("*").order("created_at", { ascending: false }).limit(50);
    if (i === 0) q = q.eq("status", "ready").is("driver_id", null);
    else if (i === 1) q = q.eq("driver_id", currentUser.id).in("status", ["delivering"]);
    else q = q.eq("driver_id", currentUser.id).eq("status", "done").eq("driver_archived", false);
    const { data, error } = await q;
    if (error) throw error;
    const list = (data || []).map(mapOrder);
    if (!list.length) {
      box.innerHTML = '<div class="card center muted">' + esc(t(i === 0 ? "noAvailable" : "noOrders")) + "</div>";
      return;
    }
    // driver earnings summary on history tab (all completed, archived included)
    let summaryHtml = "";
    if (i === 2) {
      let allDone = [];
      try {
        const ar = await sb.from("orders").select("delivery_fee_yuan").eq("driver_id", currentUser.id).eq("status", "done");
        allDone = ar.data || [];
      } catch (e) {}
      const totalFee = allDone.reduce((a, o) => a + (Number(o.delivery_fee_yuan) || 0), 0);
      summaryHtml = '<div class="card" style="background:#e8f5e9;text-align:center">' +
        '<div style="font-size:13px;color:#666">' + esc(t("totalDeliveries")) + ": <b>" + allDone.length + "</b></div>" +
        '<div style="font-size:20px;font-weight:800;color:#2e7d32">💰 ' + money(totalFee) + "</div>" +
        '<div style="font-size:12px;color:#666">' + esc(t("totalEarnings")) + "</div></div>";
    }
    const sids = [...new Set(list.map(o => o.shopId).filter(Boolean))];
    const shopMap = {};
    if (sids.length) {
      try {
        const sr = await sb.from("shops").select("id,name_zh,name_my,name_en,address_zh,address_my,phone").in("id", sids);
        (sr.data || []).forEach(x => { shopMap[x.id] = x; });
      } catch (e) {}
    }
    box.innerHTML = summaryHtml + list.map(o => {
      const sh = shopMap[o.shopId] || {};
      const shName = shopName(sh) || o.shopId || "";
      const shAddr = sh.address_zh || sh.address_my || "";
      const items = (o.items || []).map(it =>
        "<div>\u2022 " + esc(it.name_my || it.name_zh || it.name_en || "") + " \u00d7 " + (it.qty || 0) + "</div>").join("");
      return '<div class="card" style="padding:8px 10px;font-size:13px;line-height:1.5"><div style="display:flex;justify-content:space-between;align-items:center"><b>' + money(o.total) + '</b> <span class="status ' + o.status + '">' + esc(t("status_" + o.status)) + "</span></div>" +
      '<div>' + items + "</div>" +
      '<div style="font-size:12px;font-weight:700;color:' + (o.payMethod === "cod" ? "#c00" : "#0a0") + '">' +
      "💰 " + esc(t("pay_" + o.payMethod)) + (o.payTxn ? " · " + esc(o.payTxn) : "") + "</div>" +
      '<div class="muted" style="font-size:12px">' +
      "🏪 <b>" + esc(shName) + "</b>" + (shAddr ? "<br>📍 " + esc(shAddr) : "") + (sh.phone ? ' · <a href="tel:' + esc(sh.phone) + '">' + esc(sh.phone) + "</a>" : "") + "<br>" +
      "\uD83D\uDCCD " + esc(o.deliveryAddress || "") + "<br>" +
      "\uD83D\uDC64 " + esc(o.customerName || "") + (o.customerPhone ? ' \u00b7 <a href="tel:' + esc(o.customerPhone) + '">' + esc(o.customerPhone) + "</a>" : "") + " \u00b7 " + esc(fmtTime(o.createdAt)) + "</div>" +
      (i === 0 ? '<div style="margin-top:6px"><button class="btn small green" data-acc="' + o.id + '">' + esc(t("acceptDelivery")) + "</button></div>"
        : i === 1 ? '<div style="margin-top:6px;display:flex;gap:8px"><button class="btn small green" data-dlv="' + o.id + '">' + esc(t("markDelivered")) + '</button><button class="btn small gray" data-rel="' + o.id + '">' + esc(t("releaseDelivery")) + "</button></div>"
        : '<div style="margin-top:6px"><button class="btn small gray" data-arch="' + o.id + '">' + esc(t("del")) + "</button></div>") +
      "</div>";
    }).join("");
    box.querySelectorAll("[data-acc]").forEach(b => b.onclick = () => acceptDelivery(b.getAttribute("data-acc")));
    box.querySelectorAll("[data-dlv]").forEach(b => b.onclick = () => driverDelivered(b.getAttribute("data-dlv")));
    box.querySelectorAll("[data-rel]").forEach(b => b.onclick = () => releaseDelivery(b.getAttribute("data-rel")));
    box.querySelectorAll("[data-arch]").forEach(b => b.onclick = () => archiveDelivery(b.getAttribute("data-arch")));
  } catch (e) { box.innerHTML = '<div class="card">\u26A0\uFE0F ' + esc(e.message) + "</div>"; }
}
async function acceptDelivery(orderId) {
  const { data, error } = await sb.from("orders").update({ driver_id: currentUser.id, status: "delivering" }).eq("id", orderId).is("driver_id", null).eq("status", "ready").select("id");
  if (error) { toast("⚠️ " + error.message); return; }
  if (!data || !data.length) { prettyToast("⚠️", t("alreadyTaken"), "red"); drawDriverTab(0); return; }
  // broadcast to other drivers so it disappears from their lists immediately
  try {
    const bc = sb.channel("driver-broadcast");
    await new Promise((res) => {
      const to = setTimeout(res, 3000);
      bc.subscribe((s) => { if (s === "SUBSCRIBED") { clearTimeout(to); res(); } });
    });
    await bc.send({ type: "broadcast", event: "claimed", payload: { orderId: orderId } });
    try { await sb.removeChannel(bc); } catch (e) {}
  } catch (e) {}
  prettyToast("✅", t("done"), "green"); setDriverTab(1);
}
async function driverDelivered(orderId) {
  if (!(await confirmDlg(t("markDelivered") + "?"))) return;
  const { error } = await sb.from("orders").update({ status: "done" }).eq("id", orderId).eq("driver_id", currentUser.id);
  if (error) toast("⚠️ " + error.message);
  else drawDriverTab(1);
}
async function releaseDelivery(orderId) {
  if (!(await confirmDlg(t("releaseDelivery") + "?"))) return;
  const { error } = await sb.from("orders").update({ driver_id: null, status: "ready" }).eq("id", orderId).eq("driver_id", currentUser.id);
  if (error) toast("⚠️ " + error.message);
  else { prettyToast("✅", t("done"), "green"); drawDriverTab(1); }
}
async function archiveDelivery(orderId) {
  if (!(await confirmDlg(t("del") + "?"))) return;
  const { error } = await sb.from("orders").update({ driver_archived: true }).eq("id", orderId).eq("driver_id", currentUser.id);
  if (error) toast("⚠️ " + error.message);
  else drawDriverTab(2);
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
    '<div class="tab' + (adminTab === "shops" ? " active" : "") + '" onclick="setAdminTab(\'shops\')"><span class="tic">' + ICONS.store + "</span> " + esc(t("allShops")) + "</div>" +
    '<div class="tab' + (adminTab === "users" ? " active" : "") + '" onclick="setAdminTab(\'users\')"><span class="tic">' + ICONS.user + "</span> " + esc(t("allUsers")) + "</div>" +
    '<div class="tab' + (adminTab === "orders" ? " active" : "") + '" onclick="setAdminTab(\'orders\')"><span class="tic">' + ICONS.box + "</span> " + esc(t("allOrders")) + "</div>" +
    '<div class="tab' + (adminTab === "reports" ? " active" : "") + '" onclick="setAdminTab(\'reports\')"><span class="tic">' + ICONS.flag + "</span> " + esc(t("reports")) + "</div>" +
    '<div class="tab' + (adminTab === "drivers" ? " active" : "") + '" onclick="setAdminTab(\'drivers\')">🛵 ' + esc(t("pendingDrivers")) + "</div>" +
    '<div class="tab' + (adminTab === "posts" ? " active" : "") + '" onclick="setAdminTab(\'posts\')">📢 ' + esc(t("posts") || "Posts") + "</div>" +
    "</div><div id=\"atab\"></div>";
  const box = document.getElementById("atab");
  if (adminTab === "shops") {
    const { data, error } = await sb.from("shops").select("*").order("approved", { ascending: true }).order("created_at", { ascending: false });
    if (error) { box.innerHTML = "⚠️ " + esc(error.message); return; }
    const list = (data || []).map(mapShop);
    box.innerHTML =
      '<div class="card"><div class="rowbtns" style="justify-content:space-between">' +
      '<button class="btn small" onclick="importSamples()">📥 ' + esc(t("loadSamples")) + "</button>" +
      '<button class="btn small gray" style="opacity:0.7" onclick="deleteSamples()">🗑 ' + esc(t("deleteSamples")) + "</button>" +
      "</div></div>" +
      list.map(s => '<div class="card"><b>' + esc(shopName(s)) + "</b>" +
        (s.sample ? '<span class="badge">' + esc(t("sampleBadge")) + "</span>" : "") +
        (s.approved ? "" : ' <span class="badge" style="background:#fff3cd;color:#856404">' + esc(t("pendingShops")) + "</span>") +
        '<div class="muted">' + esc(s.ownerName || "") + " · " + esc(s.phone || "") + "</div>" +
        '<div class="rowbtns" style="display:flex;flex-direction:row;gap:8px;align-items:center">' +
        (!s.approved ? '<button class="btn small green" onclick="adminApproveShop(\'' + s.id + "',true)\">" + esc(t("approve")) + "</button>" : "") +
        '<button class="btn small gray" onclick="adminDelShop(\'' + s.id + "')\">" + esc(t("del")) + "</button></div></div>").join("");
  } else if (adminTab === "users") {
    const { data, error } = await sb.from("users").select("*");
    if (error) { box.innerHTML = "⚠️ " + esc(error.message); return; }
    const list = (data || []).map(mapUser);
    box.innerHTML = '<div class="card"><table class="list"><tr><th>' + esc(t("yourName")) +
      "</th><th>" + esc(t("email")) + "</th><th>role</th><th></th></tr>" +
      list.map(u => "<tr><td>" + esc(u.name || "") + "</td><td>" + esc(u.email || "") + "</td><td>" + esc(u.role || "") +
        (u.banned ? ' <span class="badge" style="background:#f8d7da;color:#721c24">' + esc(t("banned")) + "</span>" : "") + "</td>" +
        '<td><button class="btn small ' + (u.banned ? "" : "gray") + '" onclick="adminBanUser(\'' + u.id + "'," + (!u.banned) + ')">' + esc(t(u.banned ? "unban" : "ban")) + "</button> " +
        '<button class="btn small" style="background:#dc3545;color:#fff" onclick="adminDeleteUser(\'' + u.id + "')\">🗑️</button></td></tr>").join("") +
      "</table></div>";
  } else if (adminTab === "reports") {
    const { data, error } = await sb.from("reports").select("*").order("created_at", { ascending: false }).limit(100);
    if (error) { box.innerHTML = "⚠️ " + esc(error.message); return; }
    const list = data || [];
    const uids = [...new Set(list.flatMap(r => [r.reporter_id, r.reported_user_id]))];
    let unames = {};
    if (uids.length) {
      const { data: us } = await sb.from("users").select("id,first_name,last_name,email").in("id", uids);
      (us || []).forEach(u => { unames[u.id] = ((u.first_name || "") + " " + (u.last_name || "")).trim() || u.email || u.id.slice(0, 8); });
    }
    box.innerHTML = list.length ? list.map(r =>
      '<div class="card"><b>' + esc(unames[r.reported_user_id] || "?") + '</b>' +
      ' <span class="status ' + (r.status === "open" ? "pending" : "done") + '">' + esc(r.status) + "</span>" +
      '<div class="muted">' + esc(t("report")) + ": " + esc(unames[r.reporter_id] || "?") + " · " + esc(fmtTime(r.created_at)) + "</div>" +
      (r.reason ? "<div>" + esc(r.reason) + "</div>" : "") +
      '<div class="rowbtns">' +
      '<button class="btn small ' + (r.status === "open" ? "gray" : "") + '" onclick="adminBanUser(\'' + r.reported_user_id + "',true)\">" + esc(t("ban")) + "</button>" +
      '<button class="btn small gray" onclick="adminResolveReport(\'' + r.id + "')\">" + esc(t("del")) + "</button></div></div>").join("")
      : '<div class="card center muted">' + esc(t("noChats")) + "</div>";
  } else if (adminTab === "drivers") {
    const { data, error } = await sb.from("users").select("*").eq("role", "driver").order("driver_approved", { ascending: true }).order("created_at", { ascending: false });
    if (error) { box.innerHTML = "⚠️ " + esc(error.message); return; }
    const list = (data || []).map(mapUser);
    box.innerHTML = list.length ? list.map(u =>
      '<div class="card"><b>' + esc(u.name || "") + "</b> " +
      (u.driverApproved ? '<span class="badge" style="background:#d4edda;color:#155724">✓</span>'
        : '<span class="badge" style="background:#fff3cd;color:#856404">' + esc(t("pendingDrivers")) + "</span>") +
      '<div class="muted">' + esc(u.email || "") + (u.phone ? " · " + esc(u.phone) : "") + "</div>" +
      '<div class="rowbtns" style="display:flex;flex-direction:row;gap:8px;align-items:center">' +
      (!u.driverApproved ? '<button class="btn small green" data-addrv="' + u.id + '">' + esc(t("approve")) + "</button>" : "") +
      (u.driverApproved ? '<button class="btn small gray" data-rejdrv="' + u.id + '">' + esc(t("reject")) + "</button>" : "") +
      "</div></div>").join("")
      : '<div class="card center muted">' + esc(t("noOrders")) + "</div>";
    box.querySelectorAll("[data-addrv]").forEach(b => b.onclick = () => adminApproveDriver(b.getAttribute("data-addrv"), true));
    box.querySelectorAll("[data-rejdrv]").forEach(b => b.onclick = () => adminApproveDriver(b.getAttribute("data-rejdrv"), false));
  } else if (adminTab === "posts") {
    const { data, error } = await sb.from("posts").select("id,body,shop_id,created_at").order("created_at", { ascending: false }).limit(100);
    if (error) { box.innerHTML = "⚠️ " + esc(error.message); return; }
    const list = data || [];
    const sids = [...new Set(list.map(p => p.shop_id).filter(Boolean))];
    const shopNames = {};
    if (sids.length) {
      const { data: ss } = await sb.from("shops").select("id,name_my,name_zh").in("id", sids);
      (ss || []).forEach(s => { shopNames[s.id] = s.name_my || s.name_zh || ""; });
    }
    box.innerHTML = list.length ? list.map(p =>
      '<div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
      '<div><div>' + esc((p.body || "").slice(0, 80)) + '</div>' +
      '<div class="muted" style="font-size:12px">' + esc(shopNames[p.shop_id] || "") + '</div></div>' +
      '<button class="btn small" style="background:#dc3545;color:#fff" data-delpost="' + p.id + '">🗑️</button></div>').join("")
      : '<div class="card center muted">' + esc(t("noOrders")) + "</div>";
    box.querySelectorAll("[data-delpost]").forEach(b => b.onclick = () => adminDeletePost(b.getAttribute("data-delpost")));
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
async function adminApproveDriver(uid, approve) {
  const { error } = await sb.from("users").update({ driver_approved: !!approve }).eq("id", uid);
  if (error) toast("⚠️ " + error.message); else viewAdmin();
}
function setAdminTab(tab) { adminTab = tab; viewAdmin(); }
async function adminApproveShop(id) {
  const { error } = await sb.from("shops").update({ approved: true }).eq("id", id);
  if (error) toast("\u26A0\uFE0F " + error.message); else viewAdmin();
}
async function adminBanUser(uid, ban) {
  if (ban && !(await confirmDlg(t("ban") + "?"))) return;
  const { error } = await sb.from("users").update({ banned: !!ban }).eq("id", uid);
  if (error) toast("\u26A0\uFE0F " + error.message); else viewAdmin();
}
/* Admin: fully delete a user (test accounts). Deletes their shops (cascades
 * menu/posts), orders cascade, then blocks re-login via deleted_users. */
async function adminDeleteUser(uid) {
  if (uid === currentUser.id) { toast("\u26A0\uFE0F"); return; }
  if (!(await confirmDlg("\uD83D\uDDD1\uFE0F " + t("del") + "?"))) return;
  try {
    // delete their shops first (cascades menu_items + posts)
    const { data: shops } = await sb.from("shops").select("id").eq("owner_id", uid);
    for (const s of (shops || [])) {
      await sb.from("shops").delete().eq("id", s.id);
    }
    // block re-login, then delete public user row (orders/conversations cascade)
    await sb.from("deleted_users").insert({ id: uid });
    const { error } = await sb.from("users").delete().eq("id", uid);
    if (error) throw error;
    prettyToast("\u2705", t("done"), "green");
    viewAdmin();
  } catch (e) { toast("\u26A0\uFE0F " + e.message); }
}
/* Admin: delete a post directly. */
async function adminDeletePost(pid) {
  if (!(await confirmDlg("\uD83D\uDDD1\uFE0F " + t("del") + "?"))) return;
  const { error } = await sb.from("posts").delete().eq("id", pid);
  if (error) toast("\u26A0\uFE0F " + error.message); else viewAdmin();
}
async function adminResolveReport(id) {
  const { error } = await sb.from("reports").delete().eq("id", id);
  if (error) toast("\u26A0\uFE0F " + error.message); else viewAdmin();
}
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
    prettyToast("✅", t("done"), "green");
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
