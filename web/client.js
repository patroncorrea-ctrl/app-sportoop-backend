// Application client : nutrition (8 blocs repas) et sport (programme de la semaine).
import {
  $, api, aujourdhuiLocal, aujourdhuiServeur, dateLisible, decalerJours, ecranConnexion, ecranNouveauMotDePasse,
  ERREUR_LIEN, esc, etatSession, modale, motDePasseADefinir, oublierMotDePasseADefinir, quandNonAuthentifie,
  sessionCourante, supabase, toast,
} from "./commun.js";

const LIBELLES_REPAS = {
  PETIT_DEJEUNER: "Petit-déjeuner", COLLATION_MATIN: "Collation du matin", DEJEUNER: "Déjeuner",
  COLLATION_APRES_MIDI: "Collation de l'après-midi", DINER: "Dîner", PRE_WORKOUT: "Avant le sport",
  WORKOUT: "Pendant le sport", POST_WORKOUT: "Après le sport",
};
const MACROS = [["proteines", "Protéines", "bg-sky-500"], ["glucides", "Glucides", "bg-amber-500"], ["lipides", "Lipides", "bg-rose-500"]];

// « Aujourd'hui » = journée locale du client : le journal alimentaire suit son fuseau (le serveur n'impose
// aucune date pour la nutrition). La date de Paris ne sert qu'à prévoir le contrôle « séance future ».
const etat = {
  onglet: "nutrition", jour: aujourdhuiLocal(), semaine: aujourdhuiLocal(),
  aujourdhui: aujourdhuiLocal(), jourServeur: aujourdhuiServeur(), boutons: [],
};
const racine = $("#app");

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
async function demarrer() {
  // Après une invitation / réinitialisation, le mot de passe doit être choisi avant tout accès,
  // y compris si la page a été rechargée ou rouverte entre-temps (marqueur conservé jusqu'au succès).
  if (motDePasseADefinir()) {
    if (await attendreSession()) {
      await ecranNouveauMotDePasse(racine);
      toast("Mot de passe enregistré.", "ok");
    } else {
      oublierMotDePasseADefinir(); // plus de session : la connexion normale reprend la main
    }
  }
  if (ERREUR_LIEN && (await sessionCourante())) {
    toast(ERREUR_LIEN, "erreur"); // lien périmé ouvert alors qu'une session existe déjà
    history.replaceState(null, "", location.pathname);
  }
  let message = "";
  for (let essai = 0; ; essai++) {
    // Supabase injoignable pendant le rafraîchissement du jeton : la session est conservée, pas d'écran de
    // connexion ; api() répondra « service momentanément indisponible » avec un bouton Réessayer.
    const { session, indisponible } = await etatSession();
    if (!session && !indisponible) await ecranConnexion(racine, "ADRM Sportoop", { message });
    try {
      await api("/journal");
      break;
    } catch (e) {
      // 401 : refus CONFIRMÉ par Supabase (session révoquée, déconnexion sur un autre appareil…), voir api().
      // Une panne passagère arrive ici en 503 et garde la session. On oublie la session locale et on
      // redemande une connexion, une seule fois.
      if (e.status === 401 && essai === 0) {
        await supabase.auth.signOut({ scope: "local" }).catch(() => {});
        message = "Votre session a expiré : reconnectez-vous.";
        continue;
      }
      return ecranSansAcces(e);
    }
  }
  quandNonAuthentifie(sessionExpiree);
  etat.boutons = await api("/boutons").catch(() => []);
  structure();
  afficher();
  surveillerChangementDeJour();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

// Session refusée en cours d'utilisation, refus confirmé par Supabase (voir api()) : retour à l'écran de
// connexion. Une indisponibilité passagère n'appelle pas cette fonction : l'appel échoue avec un message.
let sessionPerdue = false;
async function sessionExpiree() {
  if (sessionPerdue) return;
  sessionPerdue = true;
  await supabase.auth.signOut({ scope: "local" }).catch(() => {});
  location.reload();
}

// L'application peut rester ouverte d'un jour sur l'autre (PWA en arrière-plan) : au retour au premier
// plan et au passage de minuit (heure locale), « aujourd'hui » est recalculé pour ne pas écrire dans le
// journal de la veille. Le passage de minuit à Paris ne fait que rafraîchir les boutons de validation.
function surveillerChangementDeJour() {
  const verifier = () => {
    const nouveau = aujourdhuiLocal(), serveur = aujourdhuiServeur();
    const changementLocal = nouveau !== etat.aujourdhui, changementServeur = serveur !== etat.jourServeur;
    if (!changementLocal && !changementServeur) return;
    etat.jourServeur = serveur;
    if (changementLocal) {
      const ancien = etat.aujourdhui;
      etat.aujourdhui = nouveau;
      if (etat.jour === ancien) etat.jour = nouveau; // l'utilisateur regardait « aujourd'hui » : on le suit
      if (etat.semaine === ancien) etat.semaine = nouveau;
    }
    if (changementLocal || etat.onglet === "sport") afficher();
  };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") verifier(); });
  addEventListener("pageshow", verifier);
  addEventListener("focus", verifier);
  setInterval(verifier, 60 * 1000);
}

// supabase-js lit le jeton du lien de manière asynchrone
async function attendreSession() {
  for (let i = 0; i < 20; i++) {
    if (await sessionCourante()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const sansAccents = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Écran affiché quand l'API refuse l'accès : abonnement en attente ou résilié, compte non rattaché, panne. */
function ecranSansAcces(e) {
  // Seul un abonnement ACTIF donne accès (403 sinon) ; le motif est lu dans le code ou le message de l'API
  const motif = sansAccents(`${e.code || ""} ${e.message || ""}`);
  let message, lienCoach = false, reessayer = true;
  if (e.status === 403 && motif.includes("attente")) {
    message = "Votre inscription est bien enregistrée, mais votre accès n'est pas encore activé : il s'ouvrira dès que votre abonnement sera actif. Si vous avez déjà réglé votre abonnement, contactez votre coach.";
  } else if (e.status === 403 && motif.includes("resili")) {
    message = "Votre abonnement est résilié : l'accès à l'application est suspendu. Contactez votre coach pour le réactiver.";
  } else if (e.status === 403 && motif.includes("abonnement")) {
    message = "Votre abonnement n'est pas actif : l'accès à l'application est suspendu. Contactez votre coach.";
  } else if (e.status === 403) {
    message = motif.includes("aucune fiche") ? "Ce compte n'est rattaché à aucune fiche client." : e.message;
    lienCoach = true;
    reessayer = false;
  } else if (e.status === 401) {
    message = "Votre session n'est plus valide : déconnectez-vous puis reconnectez-vous.";
    reessayer = false;
  } else {
    message = "Le service est momentanément indisponible. Réessayez dans quelques instants.";
  }
  racine.innerHTML = `
    <div class="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center">
      <p class="text-lg max-w-md">${esc(message)}</p>
      ${lienCoach ? `<a href="coach/" class="text-emerald-400 underline">Vous êtes coach ? Accéder à l'espace coach</a>` : ""}
      <div class="flex gap-2">
        ${reessayer ? `<button id="reessayer" class="bouton">Réessayer</button>` : ""}
        <button id="deco" class="bouton-sec">Se déconnecter</button>
      </div>
    </div>`;
  $("#reessayer")?.addEventListener("click", () => location.reload());
  $("#deco").onclick = deconnexion;
}

/** Échec du chargement d'un onglet (panne passagère, réseau…) : message lisible et bouton Réessayer. */
function erreurVue(vue, e, recharger) {
  const message = e.status ? e.message : "Connexion impossible : vérifiez votre réseau puis réessayez.";
  vue.innerHTML = `
    <div class="text-center space-y-3 py-6">
      <p class="text-red-400">${esc(message)}</p>
      <button id="reessayer-vue" class="bouton-sec">Réessayer</button>
    </div>`;
  $("#reessayer-vue", vue).onclick = recharger;
}

async function deconnexion() {
  oublierMotDePasseADefinir();
  await supabase.auth.signOut().catch(() => {});
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

/** Action d'un bouton du coach : appelée directement dans le clic (geste utilisateur), window.open est autorisé. */
function executerAction(type, cible) {
  if (type === "ECRAN") {
    const ecran = String(cible).toLowerCase();
    if (ecran === "nutrition" || ecran === "sport") return changerOnglet(ecran);
    return changerOnglet("nutrition");
  }
  const url = urlSure(cible);
  if (url) window.open(url, "_blank", "noopener");
}

/**
 * Redirection prévue par le coach après la validation d'une séance. Elle arrive après l'appel à l'API,
 * donc hors du geste de l'utilisateur : Safari (iOS, macOS) bloque alors window.open sans rien signaler.
 * Pour un lien ou une vidéo, on propose donc un vrai lien que le client touche lui-même.
 */
function proposerRedirection(type, cible) {
  if (type === "ECRAN") return executerAction(type, cible);
  const url = urlSure(cible);
  if (!url) return;
  const m = modale("Votre coach vous propose la suite", `
    <a href="${esc(url)}" target="_blank" rel="noopener" class="bouton w-full block text-center">
      ${type === "VIDEO" ? "▶️ Voir la vidéo" : "🔗 Ouvrir le lien"}</a>
    <p class="text-xs text-slate-400 text-center mt-2 break-all">${esc(new URL(url).hostname)}</p>`);
  // Fermeture différée : le lien doit d'abord suivre son action par défaut (ouverture de l'onglet)
  $("a", m.corps).addEventListener("click", () => setTimeout(m.fermer, 0));
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
    if (e.status === 403) return ecranSansAcces(e); // abonnement devenu inactif en cours d'utilisation
    return erreurVue(vue, e, vueNutrition);
  }
  if (etat.onglet !== "nutrition") return;

  const pct = j.objectifs.kcal ? Math.min(100, (j.totaux.kcal / j.objectifs.kcal) * 100) : 0;
  const depasse = j.restant.kcal < 0;
  vue.innerHTML = `
    <div class="flex items-center justify-between mb-4">
      <button id="veille" class="bouton-sec" aria-label="Jour précédent">‹</button>
      <div class="text-center">
        <div class="font-semibold capitalize">${esc(dateLisible(j.date))}</div>
        ${j.date !== aujourdhuiLocal() ? `<button id="auj" class="text-xs text-emerald-400">Revenir à aujourd'hui</button>` : ""}
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
  $("#auj")?.addEventListener("click", () => { etat.jour = aujourdhuiLocal(); vueNutrition(); });
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
  const quitterScan = () => {
    const arreter = arreterScan;
    arreterScan = null;
    try { arreter?.(); } catch { /* l'arrêt de la caméra ne doit jamais bloquer le changement de mode */ }
  };
  const choisir = (mode) => {
    quitterScan();
    m.corps.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("!border-emerald-500", b.dataset.mode === mode));
    if (mode === "manuel") formulaireAliment(zone, typeRepas, m, {});
    if (mode === "scan") arreterScan = modeScan(zone, typeRepas, m);
    if (mode === "photo") modePhoto(zone, typeRepas, m);
  };
  m.corps.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => choisir(b.dataset.mode)));
  // Couper la caméra quelle que soit la façon dont la fenêtre se ferme
  new MutationObserver((_, obs) => {
    if (m.el.isConnected) return;
    try { quitterScan(); } finally { obs.disconnect(); }
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
        <label class="text-sm" id="bloc-qte">Quantité mangée (g)<input name="quantite_g" type="number" inputmode="decimal" step="any" min="0.1" max="3000" class="champ mt-1"></label>
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

// États de html5-qrcode (Html5QrcodeScannerState) : seul un lecteur en cours ou en pause peut être arrêté
const LECTEUR_EN_COURS = 2, LECTEUR_EN_PAUSE = 3;

/** Arrêt tolérant : dans html5-qrcode, stop() lève une exception SYNCHRONE si la caméra n'a pas démarré. */
function stopperLecteur(l) {
  try {
    const etatLecteur = l.getState();
    if (etatLecteur === LECTEUR_EN_COURS || etatLecteur === LECTEUR_EN_PAUSE) l.stop().catch(() => {});
  } catch { /* déjà arrêté ou jamais démarré */ }
}

/** Mode code-barres ; renvoie la fonction qui coupe la caméra (changement de mode, fermeture). */
function modeScan(zone, typeRepas, m) {
  zone.innerHTML = `
    <div id="lecteur" class="rounded-xl overflow-hidden bg-black mb-3"></div>
    <form id="form-code" class="flex gap-2">
      <input name="code" required inputmode="numeric" pattern="\\d{8,14}" title="8 à 14 chiffres" placeholder="Ou saisir le code-barres" class="champ">
      <button class="bouton shrink-0">OK</button>
    </form>
    <p id="msg-scan" class="text-sm text-slate-400 mt-2">Visez le code-barres du produit.</p>
    <button type="button" id="relancer-scan" class="hidden mt-2 text-sm text-emerald-400 hover:text-emerald-300">📷 Scanner un autre produit</button>`;
  const message = (texte) => { const el = $("#msg-scan", zone); if (el) el.textContent = texte; };
  const boutonRelancer = (visible) => $("#relancer-scan", zone)?.classList.toggle("hidden", !visible);
  let lecteur = null;   // lecteur actif ou en cours de démarrage (null = caméra coupée)
  let fini = false;     // recherche en cours
  let quitte = false;   // mode abandonné (autre mode choisi ou fenêtre fermée)

  const arreter = () => {
    const l = lecteur;
    lecteur = null;
    // Pendant la demande d'autorisation, l'arrêt est impossible : il est fait à la fin du démarrage (voir .then)
    if (l) stopperLecteur(l);
  };

  const chercher = async (code) => {
    if (fini || quitte) return;
    fini = true;
    arreter();
    boutonRelancer(false);
    message("Recherche du produit…");
    try {
      const produit = await api(`/produits/${encodeURIComponent(code)}`);
      if (!quitte) formulaireAliment(zone, typeRepas, m, produit);
    } catch (e) {
      fini = false;
      if (quitte) return;
      message(e.status === 404 ? "Produit inconnu d'Open Food Facts : utilisez l'ajout manuel." : e.message);
      boutonRelancer(true);
    }
  };

  const demarrerCamera = () => {
    if (quitte || fini || lecteur) return;
    message("Visez le code-barres du produit.");
    chargerScript("https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js").then(() => {
      const zoneVideo = $("#lecteur", zone);
      if (quitte || fini || lecteur || !zoneVideo) return;
      // Zone vierge à chaque démarrage (relance après un produit inconnu)
      zoneVideo.replaceWith(Object.assign(document.createElement("div"), { id: "lecteur", className: zoneVideo.className }));
      const F = window.Html5QrcodeSupportedFormats;
      const l = new window.Html5Qrcode("lecteur", {
        formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E], verbose: false,
      });
      lecteur = l;
      l.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 260, height: 140 } },
        (texte) => chercher(texte), () => {})
        .then(() => { if (lecteur !== l) stopperLecteur(l); }) // arrêt demandé pendant le démarrage
        .catch(() => {
          if (lecteur !== l) return;
          lecteur = null;
          message("Caméra indisponible : saisissez le code-barres.");
        });
    }).catch(() => message("Scanner indisponible : saisissez le code-barres."));
  };

  $("#form-code", zone).onsubmit = (e) => {
    e.preventDefault();
    const code = e.target.code.value.trim();
    // Code vide ou mal formé : on ne coupe pas la caméra
    if (!/^\d{8,14}$/.test(code)) return message("Le code-barres doit comporter 8 à 14 chiffres.");
    chercher(code);
  };
  $("#relancer-scan", zone).onclick = () => { boutonRelancer(false); demarrerCamera(); };

  demarrerCamera();
  return () => { quitte = true; arreter(); };
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
  // Deux boutons : « capture » ouvre directement l'appareil photo sur mobile (sans accès à la galerie),
  // le second passe par le sélecteur du système pour choisir une photo déjà prise.
  zone.innerHTML = `
    <p class="text-sm text-slate-400 mb-3">Photographiez votre assiette : l'IA estime les aliments et les quantités.
      Il s'agit d'une <strong>estimation</strong> à vérifier et corriger ensuite. La photo n'est pas conservée.</p>
    <div class="grid grid-cols-2 gap-2">
      <label class="bouton block text-center cursor-pointer">📸 Prendre une photo
        <input type="file" accept="image/*" capture="environment" class="hidden" data-photo></label>
      <label class="bouton-sec block text-center cursor-pointer">🖼️ Choisir une photo
        <input type="file" accept="image/*" class="hidden" data-photo></label>
    </div>
    <p id="msg-photo" class="text-sm mt-3"></p>`;
  let enCours = false;
  const analyser = async (e) => {
    const champ = e.target;
    const fichier = champ.files[0];
    champ.value = ""; // permet de reprendre la même photo après une erreur
    if (!fichier || enCours) return;
    enCours = true;
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
    } finally {
      enCours = false;
    }
  };
  zone.querySelectorAll("[data-photo]").forEach((champ) => (champ.onchange = analyser));
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
        <input name="quantite_g" type="number" inputmode="decimal" step="any" min="0.1" max="3000" class="champ mt-1" value="${esc(a.quantite_g ?? "")}"></label>
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
    if (e.status === 403) return ecranSansAcces(e); // abonnement devenu inactif en cours d'utilisation
    return erreurVue(vue, e, vueSport);
  }
  if (etat.onglet !== "sport") return;
  // Mise en évidence et validation : journée locale du client
  const jourMeme = aujourdhuiLocal();
  // L'API accepte jusqu'à un jour d'avance sur Paris : la date locale suffit (outre-mer compris)
  const limiteValidation = jourMeme;
  const court = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "short" });

  vue.innerHTML = `
    <div class="flex items-center justify-between mb-4">
      <button id="sem-prec" class="bouton-sec" aria-label="Semaine précédente">‹</button>
      <div class="font-semibold">Semaine du ${court(s.du)} au ${court(s.au)}</div>
      <button id="sem-suiv" class="bouton-sec" aria-label="Semaine suivante">›</button>
    </div>
    <div class="space-y-3">
      ${s.jours.map((j) => `
        <section class="carte p-4 ${j.date === jourMeme ? "!border-emerald-600" : ""}">
          <h3 class="font-semibold mb-2">${j.jour_semaine} <span class="text-sm text-slate-400 font-normal">${court(j.date)}</span></h3>
          ${j.seances.length ? j.seances.map((se) => carteSeance(se, j.date, limiteValidation, jourMeme)).join("")
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

function carteSeance(se, date, limiteValidation, jourMeme) {
  const r = se.realisation;
  const badge = r ? (r.statut === "FAIT"
    ? `<span class="text-xs bg-emerald-900 text-emerald-300 rounded-full px-2 py-0.5">✓ Faite</span>`
    : `<span class="text-xs bg-slate-800 text-slate-300 rounded-full px-2 py-0.5">Manquée</span>`) : "";
  const video = urlSure(se.video_url);
  const validable = date <= limiteValidation;
  // En avance sur Paris (La Réunion, Nouvelle-Calédonie…) : la séance du jour local n'est validable
  // qu'une fois minuit passé à Paris ; on l'explique plutôt que de laisser un vide.
  const bientot = !validable && date === jourMeme;
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
      ${bientot ? `<p class="text-xs text-slate-500 mt-2">Validation possible dès minuit, heure de Paris.</p>` : ""}
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
      <textarea name="commentaire" maxlength="1000" rows="3" placeholder="Un commentaire pour votre coach ? (facultatif)" class="champ">${esc(seance.realisation?.commentaire || "")}</textarea>
      <button class="bouton w-full">Valider</button>
    </form>`);
  // Le commentaire déjà envoyé est pré-rempli : l'enregistrement remplace la réalisation entière,
  // un champ laissé vide effacerait la remarque transmise au coach.
  const f = $("#form-valid", m.corps);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const bouton = f.querySelector("button");
    bouton.disabled = true;
    try {
      const r = await api(`/seances/${seance.id}/validation`, {
        methode: "POST",
        json: { date, statut, ressenti: statut === "FAIT" ? Number(f.ressenti.value) : null, commentaire: f.commentaire.value.trim() || null },
      });
      m.fermer();
      toast(statut === "FAIT" ? "Séance validée 💪" : "C'est noté.", "ok");
      if (r.redirection) proposerRedirection(r.redirection.cible_type, r.redirection.cible);
      if (etat.onglet === "sport") vueSport();
    } catch (err) {
      toast(err.message, "erreur");
      bouton.disabled = false;
    }
  };
}

demarrer();
