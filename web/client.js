// Application client : nutrition (8 blocs repas) et sport (programme de la semaine).
import {
  $, api, dateLisible, decalerJours, ecranConnexion, ecranNouveauMotDePasse, esc, isoLocal,
  modale, sessionCourante, supabase, toast, TYPE_LIEN,
} from "./commun.js";

const LIBELLES_REPAS = {
  PETIT_DEJEUNER: "Petit-déjeuner", COLLATION_MATIN: "Collation du matin", DEJEUNER: "Déjeuner",
  COLLATION_APRES_MIDI: "Collation de l'après-midi", DINER: "Dîner", PRE_WORKOUT: "Avant le sport",
  WORKOUT: "Pendant le sport", POST_WORKOUT: "Après le sport",
};
const MACROS = [["proteines", "Protéines", "bg-sky-500"], ["glucides", "Glucides", "bg-amber-500"], ["lipides", "Lipides", "bg-rose-500"]];

const etat = { onglet: "nutrition", jour: isoLocal(new Date()), semaine: isoLocal(new Date()), boutons: [] };
const racine = $("#app");

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
async function demarrer() {
  if ((TYPE_LIEN === "invite" || TYPE_LIEN === "recovery") && (await attendreSession())) {
    await ecranNouveauMotDePasse(racine);
    toast("Mot de passe enregistré.", "ok");
  }
  if (!(await sessionCourante())) await ecranConnexion(racine, "ADRM Sportoop");
  try {
    await api("/journal");
  } catch (e) {
    return ecranSansAcces(e);
  }
  etat.boutons = await api("/boutons").catch(() => []);
  structure();
  afficher();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

// supabase-js lit le jeton du lien de manière asynchrone
async function attendreSession() {
  for (let i = 0; i < 20; i++) {
    if (await sessionCourante()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function ecranSansAcces(e) {
  const message = e.status === 403 ? e.message : "Le service est momentanément indisponible.";
  racine.innerHTML = `
    <div class="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center">
      <p class="text-lg">${esc(message)}</p>
      ${e.status === 403 ? `<a href="coach/" class="text-emerald-400 underline">Vous êtes coach ? Accéder à l'espace coach</a>` : ""}
      <button id="deco" class="bouton-sec">Se déconnecter</button>
    </div>`;
  $("#deco").onclick = deconnexion;
}

async function deconnexion() {
  await supabase.auth.signOut();
  location.reload();
}

function structure() {
  racine.innerHTML = `
    <header class="sticky top-0 z-30 bg-slate-950/95 backdrop-blur border-b border-slate-800 px-4 py-3 flex items-center justify-between">
      <span class="font-bold tracking-wide">ADRM <span class="text-emerald-400">Sportoop</span></span>
      <button id="deco" class="text-sm text-slate-400 hover:text-white">Déconnexion</button>
    </header>
    <div id="boutons-coach" class="px-4 pt-4 flex flex-wrap gap-2"></div>
    <main id="vue" class="p-4 pb-28"></main>
    <nav class="fixed bottom-0 inset-x-0 z-30 bg-slate-900 border-t border-slate-800 pb-[env(safe-area-inset-bottom)]">
      <div class="max-w-2xl mx-auto grid grid-cols-2">
        <button data-onglet="nutrition" class="py-3 text-sm font-medium">🍽️ Nutrition</button>
        <button data-onglet="sport" class="py-3 text-sm font-medium">🏋️ Sport</button>
      </div>
    </nav>`;
  $("#deco").onclick = deconnexion;
  racine.querySelectorAll("[data-onglet]").forEach((b) => (b.onclick = () => changerOnglet(b.dataset.onglet)));
}

function changerOnglet(onglet) {
  etat.onglet = onglet;
  afficher();
  scrollTo({ top: 0 });
}

function afficher() {
  racine.querySelectorAll("[data-onglet]").forEach((b) =>
    b.classList.toggle("text-emerald-400", b.dataset.onglet === etat.onglet));
  afficherBoutonsCoach();
  return etat.onglet === "nutrition" ? vueNutrition() : vueSport();
}

// ---------------------------------------------------------------------------
// Boutons dynamiques et redirections du coach
// ---------------------------------------------------------------------------
const EMPLACEMENTS = { nutrition: ["ACCUEIL", "NUTRITION"], sport: ["ACCUEIL", "SEANCE", "SPORT"] };

function afficherBoutonsCoach() {
  const visibles = etat.boutons.filter((b) => EMPLACEMENTS[etat.onglet].includes(b.emplacement));
  const zone = $("#boutons-coach");
  zone.innerHTML = visibles.map((b, i) =>
    `<button data-bouton="${i}" class="bouton-sec text-sm">${esc(b.libelle)}</button>`).join("");
  zone.querySelectorAll("[data-bouton]").forEach((el) => {
    const b = visibles[Number(el.dataset.bouton)];
    el.onclick = () => executerAction(b.action_type, b.cible);
  });
}

function urlSure(url) {
  try { return ["http:", "https:"].includes(new URL(url).protocol) ? url : null; } catch { return null; }
}

function executerAction(type, cible) {
  if (type === "ECRAN") {
    const ecran = String(cible).toLowerCase();
    if (ecran === "nutrition" || ecran === "sport") return changerOnglet(ecran);
    return changerOnglet("nutrition");
  }
  const url = urlSure(cible);
  if (url) window.open(url, "_blank", "noopener");
}

// ---------------------------------------------------------------------------
// Nutrition
// ---------------------------------------------------------------------------
async function vueNutrition() {
  const vue = $("#vue");
  vue.innerHTML = `<p class="text-slate-400">Chargement…</p>`;
  let j;
  try {
    j = await api(`/journal?date=${etat.jour}`);
  } catch (e) {
    vue.innerHTML = `<p class="text-red-400">${esc(e.message)}</p>`;
    return;
  }
  if (etat.onglet !== "nutrition") return;

  const pct = j.objectifs.kcal ? Math.min(100, (j.totaux.kcal / j.objectifs.kcal) * 100) : 0;
  const depasse = j.restant.kcal < 0;
  vue.innerHTML = `
    <div class="flex items-center justify-between mb-4">
      <button id="veille" class="bouton-sec" aria-label="Jour précédent">‹</button>
      <div class="text-center">
        <div class="font-semibold capitalize">${esc(dateLisible(j.date))}</div>
        ${j.date !== isoLocal(new Date()) ? `<button id="auj" class="text-xs text-emerald-400">Revenir à aujourd'hui</button>` : ""}
      </div>
      <button id="lendemain" class="bouton-sec" aria-label="Jour suivant">›</button>
    </div>

    <section class="carte p-5 mb-5">
      <div class="flex items-center gap-5">
        <svg viewBox="0 0 36 36" class="w-24 h-24 -rotate-90 shrink-0">
          <circle cx="18" cy="18" r="15.9" fill="none" stroke="rgb(30 41 59)" stroke-width="3.2"></circle>
          <circle cx="18" cy="18" r="15.9" fill="none" stroke="${depasse ? "rgb(244 63 94)" : "rgb(16 185 129)"}"
            stroke-width="3.2" stroke-linecap="round" stroke-dasharray="${pct.toFixed(1)} 100"></circle>
        </svg>
        <div>
          <div class="text-3xl font-bold">${j.totaux.kcal}<span class="text-base text-slate-400"> / ${j.objectifs.kcal} kcal</span></div>
          <div class="${depasse ? "text-rose-400" : "text-emerald-400"} text-sm">
            ${depasse ? `${-j.restant.kcal} kcal au-dessus de l'objectif` : `${j.restant.kcal} kcal restantes`}</div>
        </div>
      </div>
      <div class="mt-5 space-y-3">
        ${MACROS.map(([cle, nom, couleur]) => {
          const obj = j.objectifs[cle] || 0, val = j.totaux[cle];
          const p = obj ? Math.min(100, (val / obj) * 100) : 0;
          return `<div>
            <div class="flex justify-between text-sm mb-1"><span>${nom}</span><span class="text-slate-400">${val} / ${obj} g</span></div>
            <div class="h-2 rounded-full bg-slate-800"><div class="h-2 rounded-full ${couleur}" style="width:${p}%"></div></div>
          </div>`;
        }).join("")}
      </div>
    </section>

    <div class="space-y-3">${j.repas.map(carteRepas).join("")}</div>`;

  $("#veille").onclick = () => { etat.jour = decalerJours(etat.jour, -1); vueNutrition(); };
  $("#lendemain").onclick = () => { etat.jour = decalerJours(etat.jour, 1); vueNutrition(); };
  $("#auj")?.addEventListener("click", () => { etat.jour = isoLocal(new Date()); vueNutrition(); });
  vue.querySelectorAll("[data-ajouter]").forEach((b) => (b.onclick = () => modaleAjout(b.dataset.ajouter)));
  const aliments = Object.fromEntries(j.repas.flatMap((r) => r.aliments).map((a) => [a.id, a]));
  vue.querySelectorAll("[data-aliment]").forEach((b) => (b.onclick = () => modaleEdition(aliments[b.dataset.aliment])));
}

function carteRepas(r) {
  return `
    <section class="carte p-4">
      <div class="flex items-center justify-between">
        <h3 class="font-semibold">${LIBELLES_REPAS[r.type_repas]}</h3>
        <span class="text-sm text-slate-400">${r.totaux.kcal} kcal${r.target_kcal ? ` / ${r.target_kcal}` : ""}</span>
      </div>
      ${r.consigne_coach ? `<p class="mt-2 text-sm text-emerald-300 bg-emerald-950/40 rounded-lg px-3 py-2">💬 ${esc(r.consigne_coach)}</p>` : ""}
      <ul class="mt-2 divide-y divide-slate-800">
        ${r.aliments.map((a) => `
          <li><button data-aliment="${a.id}" class="w-full text-left py-2 flex items-center justify-between gap-3">
            <span class="min-w-0">
              <span class="block truncate">${esc(a.nom_aliment)} ${a.est_estimation ? `<span class="pastille-estimation">estimation</span>` : ""}</span>
              <span class="text-xs text-slate-400">${a.quantite_g ? `${a.quantite_g} g · ` : ""}P ${a.proteines} · G ${a.glucides} · L ${a.lipides}</span>
            </span>
            <span class="text-sm shrink-0">${a.kcal} kcal</span>
          </button></li>`).join("")}
      </ul>
      <button data-ajouter="${r.type_repas}" class="mt-2 text-sm text-emerald-400 hover:text-emerald-300">+ Ajouter un aliment</button>
    </section>`;
}

const champsValeurs = (prefixe = "") => `
  <div class="grid grid-cols-2 gap-3">
    <label class="text-sm">Kcal<input name="kcal" type="number" step="0.1" min="0" required class="champ mt-1" ${prefixe}></label>
    <label class="text-sm">Protéines (g)<input name="proteines" type="number" step="0.1" min="0" value="0" class="champ mt-1"></label>
    <label class="text-sm">Glucides (g)<input name="glucides" type="number" step="0.1" min="0" value="0" class="champ mt-1"></label>
    <label class="text-sm">Lipides (g)<input name="lipides" type="number" step="0.1" min="0" value="0" class="champ mt-1"></label>
  </div>`;

function modaleAjout(typeRepas) {
  const m = modale(`Ajouter — ${LIBELLES_REPAS[typeRepas]}`, `
    <div class="grid grid-cols-3 gap-2 mb-4" id="modes">
      <button data-mode="manuel" class="bouton-sec text-sm">✍️ Manuel</button>
      <button data-mode="scan" class="bouton-sec text-sm">📷 Code-barres</button>
      <button data-mode="photo" class="bouton-sec text-sm">🍽️ Photo</button>
    </div>
    <div id="mode"></div>`);
  const zone = $("#mode", m.corps);
  let arreterScan = null;
  const choisir = (mode) => {
    arreterScan?.();
    arreterScan = null;
    m.corps.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("!border-emerald-500", b.dataset.mode === mode));
    if (mode === "manuel") formulaireAliment(zone, typeRepas, m, {});
    if (mode === "scan") arreterScan = modeScan(zone, typeRepas, m);
    if (mode === "photo") modePhoto(zone, typeRepas, m);
  };
  m.corps.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => choisir(b.dataset.mode)));
  // Couper la caméra quelle que soit la façon dont la fenêtre se ferme
  new MutationObserver((_, obs) => {
    if (!m.el.isConnected) { arreterScan?.(); obs.disconnect(); }
  }).observe(document.body, { childList: true });
  choisir("manuel");
}

/** Formulaire d'ajout ; `produit` pré-remplit les valeurs pour 100 g (scan). */
function formulaireAliment(zone, typeRepas, m, produit) {
  const p100 = produit.pour_100g || {};
  zone.innerHTML = `
    <form class="space-y-3" id="form-aliment">
      ${produit.code_barres ? `<p class="text-xs text-slate-400">Code-barres ${esc(produit.code_barres)}${produit.marque ? ` · ${esc(produit.marque)}` : ""}</p>` : ""}
      <input name="nom_aliment" required maxlength="200" placeholder="Nom de l'aliment" class="champ" value="${esc(produit.nom || "")}">
      <div class="grid grid-cols-2 gap-3">
        <label class="text-sm">Valeurs indiquées
          <select name="base" class="champ mt-1">
            <option value="100g">pour 100 g</option>
            <option value="portion" ${produit.code_barres ? "disabled" : ""}>pour la portion</option>
          </select></label>
        <label class="text-sm" id="bloc-qte">Quantité mangée (g)<input name="quantite_g" type="number" step="1" min="1" max="3000" class="champ mt-1"></label>
      </div>
      ${champsValeurs()}
      <button class="bouton w-full">Ajouter</button>
    </form>`;
  const f = $("#form-aliment", zone);
  for (const cle of ["kcal", "proteines", "glucides", "lipides"]) if (p100[cle] != null) f[cle].value = p100[cle];
  // La quantité n'est obligatoire que pour des valeurs données pour 100 g
  const majBase = () => { f.quantite_g.required = f.base.value === "100g"; };
  f.base.onchange = majBase;
  majBase();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const corps = {
      nom_aliment: f.nom_aliment.value.trim(), base: f.base.value,
      methode_ajout: produit.code_barres ? "scan_barcode" : "manuel",
      code_barres: produit.code_barres || null,
      quantite_g: f.quantite_g.value ? Number(f.quantite_g.value) : null,
      kcal: Number(f.kcal.value), proteines: Number(f.proteines.value || 0),
      glucides: Number(f.glucides.value || 0), lipides: Number(f.lipides.value || 0),
    };
    const bouton = f.querySelector("button");
    bouton.disabled = true;
    try {
      await api(`/journal/${etat.jour}/${typeRepas}/aliments`, { methode: "POST", json: corps });
      m.fermer();
      toast("Aliment ajouté.", "ok");
      vueNutrition();
    } catch (err) {
      toast(err.message, "erreur");
      bouton.disabled = false;
    }
  };
}

function modeScan(zone, typeRepas, m) {
  zone.innerHTML = `
    <div id="lecteur" class="rounded-xl overflow-hidden bg-black mb-3"></div>
    <form id="form-code" class="flex gap-2">
      <input name="code" inputmode="numeric" pattern="\\d{8,14}" placeholder="Ou saisir le code-barres" class="champ">
      <button class="bouton shrink-0">OK</button>
    </form>
    <p id="msg-scan" class="text-sm text-slate-400 mt-2">Visez le code-barres du produit.</p>`;
  let lecteur = null, fini = false;
  const chercher = async (code) => {
    if (fini) return;
    fini = true;
    arreter();
    $("#msg-scan", zone).textContent = "Recherche du produit…";
    try {
      const produit = await api(`/produits/${encodeURIComponent(code)}`);
      formulaireAliment(zone, typeRepas, m, produit);
    } catch (e) {
      fini = false;
      $("#msg-scan", zone).textContent = e.status === 404
        ? "Produit inconnu d'Open Food Facts : utilisez l'ajout manuel." : e.message;
    }
  };
  const arreter = () => { if (lecteur) { lecteur.stop().catch(() => {}); lecteur = null; } };
  $("#form-code", zone).onsubmit = (e) => { e.preventDefault(); chercher(e.target.code.value.trim()); };

  chargerScript("https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js").then(() => {
    if (fini || !$("#lecteur", zone)) return;
    const F = window.Html5QrcodeSupportedFormats;
    lecteur = new window.Html5Qrcode("lecteur", {
      formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E], verbose: false,
    });
    lecteur.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 260, height: 140 } },
      (texte) => chercher(texte), () => {})
      .catch(() => { $("#msg-scan", zone).textContent = "Caméra indisponible : saisissez le code-barres."; });
  }).catch(() => { $("#msg-scan", zone).textContent = "Scanner indisponible : saisissez le code-barres."; });
  return arreter;
}

const scriptsCharges = {};
function chargerScript(src) {
  return (scriptsCharges[src] ??= new Promise((ok, ko) => {
    const s = document.createElement("script");
    s.src = src; s.onload = ok; s.onerror = ko;
    document.head.append(s);
  }));
}

function modePhoto(zone, typeRepas, m) {
  zone.innerHTML = `
    <p class="text-sm text-slate-400 mb-3">Prenez votre assiette en photo : l'IA estime les aliments et les quantités.
      Il s'agit d'une <strong>estimation</strong> à vérifier et corriger ensuite. La photo n'est pas conservée.</p>
    <label class="bouton w-full block text-center cursor-pointer">📸 Prendre ou choisir une photo
      <input type="file" accept="image/*" capture="environment" class="hidden" id="photo"></label>
    <p id="msg-photo" class="text-sm mt-3"></p>`;
  $("#photo", zone).onchange = async (e) => {
    const fichier = e.target.files[0];
    if (!fichier) return;
    const msg = $("#msg-photo", zone);
    msg.className = "text-sm mt-3 text-slate-300";
    msg.textContent = "Analyse en cours…";
    const donnees = new FormData();
    donnees.append("photo", await reduireImage(fichier), "assiette.jpg");
    try {
      const r = await api(`/journal/${etat.jour}/${typeRepas}/photo`, { methode: "POST", formData: donnees });
      m.fermer();
      toast(`${r.aliments.length} aliment(s) estimé(s) : vérifiez les quantités.`, "ok");
      vueNutrition();
    } catch (err) {
      msg.className = "text-sm mt-3 text-red-400";
      msg.textContent = err.status === 503 ? "L'estimation par photo n'est pas encore activée par votre coach." : err.message;
    }
  };
}

/** Réduit la photo (1600 px max, JPEG) pour un envoi rapide. */
async function reduireImage(fichier) {
  try {
    const img = await createImageBitmap(fichier);
    const echelle = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = Object.assign(document.createElement("canvas"), { width: img.width * echelle, height: img.height * echelle });
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.85));
  } catch {
    return fichier; // format non décodable par le navigateur (ex. HEIC) : envoi tel quel
  }
}

function modaleEdition(a) {
  const m = modale("Modifier l'aliment", `
    ${a.est_estimation ? `<p class="text-sm text-amber-300 mb-3">Valeurs estimées par l'IA : corrigez-les si besoin.</p>` : ""}
    <form id="form-edit" class="space-y-3">
      <input name="nom_aliment" required maxlength="200" class="champ" value="${esc(a.nom_aliment)}">
      <label class="text-sm block">Quantité (g)
        <input name="quantite_g" type="number" step="1" min="1" max="3000" class="champ mt-1" value="${a.quantite_g ?? ""}"></label>
      <p class="text-xs text-slate-400">Si vous ne changez que la quantité, les valeurs sont recalculées automatiquement.</p>
      ${champsValeurs()}
      <div class="flex gap-2">
        <button class="bouton flex-1">Enregistrer</button>
        <button type="button" id="suppr" class="bouton-sec !text-red-400">Supprimer</button>
      </div>
    </form>`);
  const f = $("#form-edit", m.corps);
  for (const cle of ["kcal", "proteines", "glucides", "lipides"]) f[cle].value = a[cle];
  f.onsubmit = async (e) => {
    e.preventDefault();
    const modif = {};
    if (f.nom_aliment.value.trim() !== a.nom_aliment) modif.nom_aliment = f.nom_aliment.value.trim();
    if (f.quantite_g.value && Number(f.quantite_g.value) !== Number(a.quantite_g)) modif.quantite_g = Number(f.quantite_g.value);
    for (const cle of ["kcal", "proteines", "glucides", "lipides"])
      if (Number(f[cle].value) !== Number(a[cle])) modif[cle] = Number(f[cle].value);
    if (!Object.keys(modif).length && a.est_estimation) modif.nom_aliment = a.nom_aliment; // valider l'estimation telle quelle
    if (!Object.keys(modif).length) return m.fermer();
    try {
      await api(`/aliments/${a.id}`, { methode: "PATCH", json: modif });
      m.fermer();
      toast("Aliment mis à jour.", "ok");
      vueNutrition();
    } catch (err) { toast(err.message, "erreur"); }
  };
  $("#suppr", m.corps).onclick = async () => {
    if (!confirm(`Supprimer « ${a.nom_aliment} » ?`)) return;
    try {
      await api(`/aliments/${a.id}`, { methode: "DELETE" });
      m.fermer();
      toast("Aliment supprimé.");
      vueNutrition();
    } catch (err) { toast(err.message, "erreur"); }
  };
}

// ---------------------------------------------------------------------------
// Sport
// ---------------------------------------------------------------------------
async function vueSport() {
  const vue = $("#vue");
  vue.innerHTML = `<p class="text-slate-400">Chargement…</p>`;
  let s;
  try {
    s = await api(`/seances/semaine?date=${etat.semaine}`);
  } catch (e) {
    vue.innerHTML = `<p class="text-red-400">${esc(e.message)}</p>`;
    return;
  }
  if (etat.onglet !== "sport") return;
  const aujourdhui = isoLocal(new Date());
  const court = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "short" });

  vue.innerHTML = `
    <div class="flex items-center justify-between mb-4">
      <button id="sem-prec" class="bouton-sec" aria-label="Semaine précédente">‹</button>
      <div class="font-semibold">Semaine du ${court(s.du)} au ${court(s.au)}</div>
      <button id="sem-suiv" class="bouton-sec" aria-label="Semaine suivante">›</button>
    </div>
    <div class="space-y-3">
      ${s.jours.map((j) => `
        <section class="carte p-4 ${j.date === aujourdhui ? "!border-emerald-600" : ""}">
          <h3 class="font-semibold mb-2">${j.jour_semaine} <span class="text-sm text-slate-400 font-normal">${court(j.date)}</span></h3>
          ${j.seances.length ? j.seances.map((se) => carteSeance(se, j.date, aujourdhui)).join("")
            : `<p class="text-sm text-slate-500">Repos</p>`}
        </section>`).join("")}
    </div>`;
  $("#sem-prec").onclick = () => { etat.semaine = decalerJours(etat.semaine, -7); vueSport(); };
  $("#sem-suiv").onclick = () => { etat.semaine = decalerJours(etat.semaine, 7); vueSport(); };
  const seances = Object.fromEntries(s.jours.flatMap((j) => j.seances.map((se) => [`${se.id}|${j.date}`, se])));
  vue.querySelectorAll("[data-valider]").forEach((b) => (b.onclick = () => {
    const [cle, statut] = b.dataset.valider.split("#");
    modaleValidation(seances[cle], cle.split("|")[1], statut);
  }));
}

function carteSeance(se, date, aujourdhui) {
  const r = se.realisation;
  const badge = r ? (r.statut === "FAIT"
    ? `<span class="text-xs bg-emerald-900 text-emerald-300 rounded-full px-2 py-0.5">✓ Faite</span>`
    : `<span class="text-xs bg-slate-800 text-slate-300 rounded-full px-2 py-0.5">Manquée</span>`) : "";
  const video = urlSure(se.video_url);
  const validable = date <= aujourdhui;
  return `
    <div class="border-t border-slate-800 first:border-0 pt-3 first:pt-0 mt-3 first:mt-0">
      <div class="flex items-start justify-between gap-2">
        <div>
          <div class="font-medium">${esc(se.titre)}</div>
          ${se.duree ? `<div class="text-xs text-slate-400">${esc(se.duree)}</div>` : ""}
        </div>
        ${badge}
      </div>
      <div class="flex flex-wrap gap-2 mt-2">
        ${video ? `<a href="${esc(video)}" target="_blank" rel="noopener" class="bouton-sec text-sm">▶️ Vidéo</a>` : ""}
        ${validable ? `
          <button data-valider="${se.id}|${date}#FAIT" class="bouton text-sm">${r?.statut === "FAIT" ? "Modifier" : "J'ai fait ma séance"}</button>
          ${r?.statut !== "MANQUE" ? `<button data-valider="${se.id}|${date}#MANQUE" class="bouton-sec text-sm">Manquée</button>` : ""}` : ""}
      </div>
    </div>`;
}

function modaleValidation(seance, date, statut) {
  const m = modale(statut === "FAIT" ? "Bravo ! Comment s'est passée la séance ?" : "Séance manquée", `
    <form id="form-valid" class="space-y-4">
      ${statut === "FAIT" ? `
        <div>
          <p class="text-sm mb-2">Ressenti</p>
          <div class="grid grid-cols-5 gap-2">
            ${[1, 2, 3, 4, 5].map((n) => `<label class="cursor-pointer">
              <input type="radio" name="ressenti" value="${n}" class="peer hidden" ${n === (seance.realisation?.ressenti ?? 3) ? "checked" : ""}>
              <span class="block text-center py-2 rounded-lg bg-slate-800 peer-checked:bg-emerald-600">${["😫", "😕", "😐", "🙂", "💪"][n - 1]}</span>
            </label>`).join("")}
          </div>
        </div>` : ""}
      <textarea name="commentaire" maxlength="1000" rows="3" placeholder="Un commentaire pour votre coach ? (facultatif)" class="champ"></textarea>
      <button class="bouton w-full">Valider</button>
    </form>`);
  const f = $("#form-valid", m.corps);
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api(`/seances/${seance.id}/validation`, {
        methode: "POST",
        json: { date, statut, ressenti: statut === "FAIT" ? Number(f.ressenti.value) : null, commentaire: f.commentaire.value.trim() || null },
      });
      m.fermer();
      toast(statut === "FAIT" ? "Séance validée 💪" : "C'est noté.", "ok");
      if (r.redirection) executerAction(r.redirection.cible_type, r.redirection.cible);
      if (etat.onglet === "sport") vueSport();
    } catch (err) { toast(err.message, "erreur"); }
  };
}

demarrer();
