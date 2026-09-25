// Espace coach : clients, objectifs, programme, historique, journal, règles de redirection et boutons.
// Accès direct à Supabase : la RLS (prive.est_coach()) autorise le coach sur toutes les tables métier.
import {
  $, api, dateLisible, decalerJours, ecranConnexion, ecranNouveauMotDePasse, esc, isoLocal,
  modale, sessionCourante, supabase, toast, TYPE_LIEN,
} from "../commun.js";

const JOURS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const REPAS = [
  ["PETIT_DEJEUNER", "Petit-déjeuner"], ["COLLATION_MATIN", "Collation du matin"], ["DEJEUNER", "Déjeuner"],
  ["COLLATION_APRES_MIDI", "Collation après-midi"], ["DINER", "Dîner"], ["PRE_WORKOUT", "Avant le sport"],
  ["WORKOUT", "Pendant le sport"], ["POST_WORKOUT", "Après le sport"],
];
// Statuts d'abonnement (clients.statut_abonnement) : seul ACTIF donne accès à l'application client
const STATUTS = {
  ACTIF: { nom: "actif", option: "Actif — accès ouvert", couleur: "text-emerald-400" },
  EN_ATTENTE: { nom: "en attente", option: "En attente — pas d'accès (formulaire reçu, aucun achat)", couleur: "text-amber-400" },
  RESILIE: { nom: "résilié", option: "Résilié — accès suspendu", couleur: "text-rose-400" },
};
const statutDe = (c) => STATUTS[c.statut_abonnement] || { nom: c.statut_abonnement || "inconnu", couleur: "text-slate-400" };
/** Jours de sport d'une fiche, dans l'ordre de la semaine (valeur JSONB mal formée tolérée). */
const joursDe = (c) => JOURS.filter((j) => Array.isArray(c.jours_sport) && c.jours_sport.includes(j));
const racine = $("#app");
const etat = { clients: [], clientId: null, onglet: "profil", recherche: "", jourJournal: isoLocal(new Date()) };

/** Message lisible pour une erreur Supabase (PostgREST) : codes PostgreSQL courants traduits. */
function messageErreurBase(error) {
  if (error.code === "23505") return "Cette valeur existe déjà (par exemple : e-mail déjà utilisé par une autre fiche).";
  if (error.code === "23514") return `Valeur refusée par la base (contrainte non respectée) : ${error.message}`;
  if (error.code === "42501") return "Action refusée : droits insuffisants (êtes-vous bien connecté avec le compte coach ?).";
  return `Erreur : ${error.message}`;
}

/** Message lisible pour une erreur de l'API FastAPI (le détail renvoyé par l'API est déjà en français). */
function messageErreurApi(err) {
  if (!err.status) return "Serveur injoignable : vérifiez votre connexion puis réessayez.";
  if (err.status === 401) return "Session expirée : déconnectez-vous puis reconnectez-vous.";
  if (err.status === 404 && err.message === "Not Found") return "Action introuvable sur le serveur : l'API déployée n'est peut-être pas à jour.";
  if (err.message && err.message !== `Erreur ${err.status}`) return err.message;
  return `Le serveur a répondu par une erreur (${err.status}). Réessayez dans quelques instants.`;
}

async function executer(requete, messageOk) {
  const { data, error } = await requete;
  if (error) { toast(messageErreurBase(error), "erreur"); throw error; }
  if (messageOk) toast(messageOk, "ok");
  return data;
}

const dateCourte = (iso) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
async function demarrer() {
  if (TYPE_LIEN === "recovery" && (await sessionCourante())) await ecranNouveauMotDePasse(racine);
  if (!(await sessionCourante())) await ecranConnexion(racine, "Espace coach");
  let { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    // Session locale expirée ou révoquée : on repart d'une connexion propre
    await supabase.auth.signOut({ scope: "local" });
    await ecranConnexion(racine, "Espace coach");
    ({ data: { user } } = await supabase.auth.getUser());
  }
  const { data: coach } = await supabase.from("coachs").select("nom").eq("user_id", user.id).maybeSingle();
  if (!coach) {
    racine.innerHTML = `<div class="min-h-screen flex flex-col items-center justify-center gap-4">
      <p>Cet espace est réservé au coach.</p>
      <a href="../" class="text-emerald-400 underline">Aller à l'application client</a>
      <button id="deco" class="bouton-sec">Se déconnecter</button></div>`;
    $("#deco").onclick = deconnexion;
    return;
  }
  racine.innerHTML = `
    <header class="border-b border-slate-800 px-5 py-3 flex items-center justify-between">
      <span class="font-bold">ADRM <span class="text-emerald-400">Sportoop</span> · Coach</span>
      <nav class="flex gap-4 text-sm">
        <button data-page="clients" class="hover:text-white">Clients</button>
        <button data-page="regles" class="hover:text-white">Redirections</button>
        <button data-page="boutons" class="hover:text-white">Boutons</button>
        <button id="deco" class="text-slate-400 hover:text-white">Déconnexion (${esc(coach.nom)})</button>
      </nav>
    </header>
    <div id="page" class="p-5"></div>`;
  $("#deco").onclick = deconnexion;
  racine.querySelectorAll("[data-page]").forEach((b) => (b.onclick = () => ouvrirPage(b.dataset.page)));
  ouvrirPage("clients");
}

async function deconnexion() {
  await supabase.auth.signOut();
  location.reload();
}

function ouvrirPage(page) {
  racine.querySelectorAll("[data-page]").forEach((b) => b.classList.toggle("text-emerald-400", b.dataset.page === page));
  if (page === "clients") return pageClients();
  return pageConfiguration(page === "regles" ? CONFIG_REGLES : CONFIG_BOUTONS);
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
async function chargerClients() {
  // Toutes les colonnes (le coach a accès à toute la fiche) : statut_modifie_le (date du dernier changement de
  // statut, posée par un trigger en base) n'est affichée que si la colonne existe, sans jamais faire échouer
  // la lecture de la liste si elle manque.
  etat.clients = await executer(supabase.from("clients").select("*").order("nom"));
}

/** Recharge les clients puis réaffiche la fiche, si le coach est toujours sur ce client. Renvoie true si réaffichée. */
async function rafraichirFiche(id) {
  await chargerClients();
  if (etat.clientId !== id || !$("#fiche")) return false;
  if (!client()) etat.clientId = null; // fiche supprimée entre-temps (autre onglet, autre appareil)
  listeClients();
  if (!etat.clientId) {
    $("#fiche").innerHTML = `<p class="text-slate-400">Ce client n'existe plus. Sélectionnez un client.</p>`;
    return false;
  }
  ficheClient();
  return true;
}

async function pageClients() {
  await chargerClients();
  $("#page").innerHTML = `
    <div class="grid md:grid-cols-[280px_1fr] gap-5">
      <aside class="space-y-3">
        <input id="recherche" placeholder="Rechercher un client" class="champ" value="${esc(etat.recherche)}">
        <button id="nouveau" class="bouton w-full">+ Nouveau client</button>
        <ul id="liste" class="carte divide-y divide-slate-800 max-h-[70vh] overflow-y-auto"></ul>
      </aside>
      <section id="fiche"></section>
    </div>`;
  $("#recherche").oninput = (e) => { etat.recherche = e.target.value; listeClients(); };
  $("#nouveau").onclick = modaleNouveauClient;
  listeClients();
  if (etat.clientId && etat.clients.some((c) => c.id === etat.clientId)) ficheClient();
  else $("#fiche").innerHTML = `<p class="text-slate-400">Sélectionnez un client.</p>`;
}

function listeClients() {
  const filtre = etat.recherche.toLowerCase();
  const visibles = etat.clients.filter((c) => `${c.nom} ${c.email}`.toLowerCase().includes(filtre));
  $("#liste").innerHTML = visibles.map((c) => `
    <li><button data-client="${c.id}" class="w-full text-left px-4 py-3 hover:bg-slate-800 ${c.id === etat.clientId ? "bg-slate-800" : ""}">
      <div class="font-medium">${esc(c.nom)} ${c.statut_abonnement !== "ACTIF" ? `<span class="text-xs ${statutDe(c).couleur}">${esc(statutDe(c).nom)}</span>` : ""}</div>
      <div class="text-xs text-slate-400 truncate">${esc(c.email)}</div>
    </button></li>`).join("") || `<li class="px-4 py-3 text-sm text-slate-500">Aucun client</li>`;
  $("#liste").querySelectorAll("[data-client]").forEach((b) => (b.onclick = () => {
    etat.clientId = b.dataset.client;
    listeClients();
    ficheClient();
  }));
}

function modaleNouveauClient() {
  const m = modale("Nouveau client", `
    <form id="form-nc" class="space-y-3">
      <input name="nom" required maxlength="200" placeholder="Nom" class="champ">
      <input name="email" type="email" required placeholder="E-mail" class="champ">
      <p class="text-xs text-slate-400">La fiche est créée avec un abonnement actif : vous pourrez changer ce statut dans la fiche.</p>
      <button class="bouton w-full">Créer</button>
    </form>`);
  $("#form-nc", m.corps).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const [cree] = await executer(supabase.from("clients")
      .insert({ nom: f.nom.value.trim(), email: f.email.value.trim().toLowerCase() }).select("id"), "Client créé.");
    m.fermer();
    etat.clientId = cree.id;
    etat.onglet = "profil";
    pageClients();
  };
}

const client = () => etat.clients.find((c) => c.id === etat.clientId);

function ficheClient() {
  const c = client();
  const onglets = [["profil", "Profil & objectifs"], ["programme", "Programme"], ["historique", "Historique"], ["journal", "Journal"]];
  $("#fiche").innerHTML = `
    <h2 class="text-2xl font-bold">${esc(c.nom)}</h2>
    <p class="text-sm text-slate-400 mb-4">${esc(c.email)}</p>
    <div class="flex flex-wrap gap-2 mb-5">
      ${onglets.map(([id, nom]) => `<button data-onglet="${id}" class="bouton-sec text-sm ${etat.onglet === id ? "!border-emerald-500" : ""}">${nom}</button>`).join("")}
    </div>
    <div id="contenu"></div>`;
  $("#fiche").querySelectorAll("[data-onglet]").forEach((b) => (b.onclick = () => { etat.onglet = b.dataset.onglet; ficheClient(); }));
  ({ profil: ongletProfil, programme: ongletProgramme, historique: ongletHistorique, journal: ongletJournal })[etat.onglet]();
}

function ongletProfil() {
  const c = client();
  $("#contenu").innerHTML = `
    <div class="grid lg:grid-cols-2 gap-5">
      <form id="form-obj" class="carte p-5 space-y-3">
        <h3 class="font-semibold">Objectifs quotidiens et jours de sport</h3>
        <div class="grid grid-cols-2 gap-3">
          ${[["target_kcal", "Kcal"], ["target_proteines", "Protéines (g)"], ["target_glucides", "Glucides (g)"], ["target_lipides", "Lipides (g)"]]
            .map(([cle, nom]) => `<label class="text-sm">${nom}<input name="${cle}" type="number" min="0" max="10000" required class="champ mt-1" value="${c[cle] ?? ""}"></label>`).join("")}
        </div>
        <fieldset class="text-sm">
          <legend class="mb-1">Jours de sport</legend>
          <div class="flex flex-wrap gap-x-4 gap-y-1">
            ${JOURS.map((j) => `<label class="flex items-center gap-1.5"><input type="checkbox" name="jours" value="${j}" ${joursDe(c).includes(j) ? "checked" : ""}> ${j}</label>`).join("")}
          </div>
        </fieldset>
        <label class="text-sm block">Nom<input name="nom" required maxlength="200" class="champ mt-1" value="${esc(c.nom)}"></label>
        <button class="bouton w-full">Enregistrer</button>
      </form>
      <div class="carte p-5 space-y-4 text-sm">
        <h3 class="font-semibold text-base">Compte & abonnement</h3>
        <form id="form-statut" class="space-y-2">
          <p>Abonnement : <strong class="${statutDe(c).couleur}">${esc(statutDe(c).nom)}</strong></p>
          <div class="flex gap-2">
            <select name="statut" class="champ text-sm" aria-label="Statut d'abonnement">
              ${Object.entries(STATUTS).map(([v, d]) => `<option value="${v}" ${v === c.statut_abonnement ? "selected" : ""}>${d.option}</option>`).join("")}
            </select>
            <button class="bouton-sec text-sm shrink-0">Changer</button>
          </div>
          <p class="text-xs text-slate-400">Seul « actif » donne accès à l'application.
            ${"statut_modifie_le" in c ? `${c.statut_modifie_le ? `Statut en vigueur depuis le ${dateCourte(c.statut_modifie_le)}.` : ""}
              Chaque changement est daté par la base (revue de conservation des données).` : ""}
            ${c.abonnement_maj_le ? `Dernier événement Systeme.io appliqué : ${dateCourte(c.abonnement_maj_le)}.` : ""}
            Un achat ou une résiliation Systeme.io plus récents que le dernier événement appliqué remplaceront ce choix.</p>
        </form>
        <p>Formulaire d'onboarding : ${c.formulaire_recu_le ? `reçu le ${dateCourte(c.formulaire_recu_le)}` : `<span class="text-slate-400">non reçu</span>`}</p>
        <div class="space-y-2">
          <p>Compte de connexion : ${c.user_id ? `<strong class="text-emerald-400">rattaché à la fiche</strong>` : `<strong class="text-amber-400">pas encore créé</strong>`}</p>
          <button id="acces" type="button" class="${c.user_id ? "bouton-sec" : "bouton"} text-sm">${c.user_id ? "Renvoyer un lien de connexion" : "Envoyer l'invitation"}</button>
          <p class="text-xs text-slate-400">${c.user_id
            ? "Invitation expirée ou perdue, mot de passe oublié : le client reçoit un lien pour choisir son mot de passe."
            : "Le client reçoit un e-mail pour créer son compte et choisir son mot de passe."}</p>
          ${c.statut_abonnement !== "ACTIF" ? `<p class="text-xs text-amber-300">L'abonnement n'est pas actif : même connecté, le client n'aura pas accès à l'application.</p>` : ""}
          <p id="msg-compte" class="text-sm" role="status" aria-live="polite"></p>
        </div>
      </div>
      <form id="form-sante" class="carte p-5 space-y-2 text-sm lg:col-span-2">
        <h3 class="font-semibold text-base">Contraintes de santé
          ${c.consentement_sante_le ? `<span class="font-normal text-slate-400">(consentement du ${dateCourte(c.consentement_sante_le)})</span>`
            : `<span class="font-normal text-amber-400">(consentement non enregistré)</span>`}</h3>
        ${c.consentement_sante_le ? `
          <textarea name="contraintes" rows="4" maxlength="5000" class="champ text-sm" placeholder="Aucune contrainte signalée">${esc(c.contraintes_sante || "")}</textarea>
          <button class="bouton-sec text-sm">Enregistrer les contraintes</button>` : `
          <p class="whitespace-pre-wrap">${esc(c.contraintes_sante || "—")}</p>
          <p class="text-xs text-slate-400">Sans consentement enregistré, ces données ne se saisissent pas ici : elles arrivent
            par le formulaire (case de consentement cochée) ou par un report depuis une autre fiche du même client.</p>`}
        ${c.contraintes_sante || c.consentement_sante_le
          ? `<button id="effacer-sante" type="button" class="block text-xs text-red-400 hover:underline">Effacer ces données (retrait du consentement)</button>` : ""}
      </form>
      ${c.statut_abonnement === "EN_ATTENTE" && c.formulaire_recu_le ? `
        <div class="carte !border-amber-800 p-5 space-y-2 text-sm lg:col-span-2">
          <h3 class="font-semibold text-base text-amber-300">Fiche en double ?</h3>
          <p class="text-slate-400">Achat fait avec une autre adresse que celle du formulaire : recopiez les réponses de cette
            fiche (nom, objectifs, jours de sport, contraintes de santé avec la date d'origine du consentement) dans la
            fiche de l'achat, puis supprimez cette fiche en attente.</p>
          <button id="reporter" type="button" class="bouton-sec text-sm">Reporter vers une autre fiche…</button>
        </div>` : ""}
      <div class="carte !border-red-900 p-5 space-y-2 text-sm lg:col-span-2">
        <h3 class="font-semibold text-base text-red-400">Supprimer le client</h3>
        <p class="text-slate-400">Droit à l'effacement (RGPD) : supprime définitivement la fiche, toutes les données du client et son compte de connexion.</p>
        <button id="suppr-client" type="button" class="bouton-sec !text-red-400 text-sm">Supprimer le client…</button>
      </div>
    </div>`;
  $("#form-obj").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    await executer(supabase.from("clients").update({
      nom: f.nom.value.trim(), target_kcal: +f.target_kcal.value, target_proteines: +f.target_proteines.value,
      target_glucides: +f.target_glucides.value, target_lipides: +f.target_lipides.value,
      jours_sport: [...f.querySelectorAll('[name="jours"]:checked')].map((x) => x.value), // ordre Lundi → Dimanche
    }).eq("id", c.id), "Fiche enregistrée.");
    await rafraichirFiche(c.id);
  };
  $("#form-statut").onsubmit = (e) => {
    e.preventDefault();
    changerStatut(c, e.target.statut);
  };
  $("#form-sante").onsubmit = (e) => {
    e.preventDefault();
    enregistrerSante(c, e.target);
  };
  $("#acces").onclick = (e) => envoyerAcces(c, e.currentTarget);
  $("#effacer-sante")?.addEventListener("click", () => effacerSante(c));
  $("#reporter")?.addEventListener("click", () => modaleReport(c));
  $("#suppr-client").onclick = () => modaleSuppressionClient(c);
}

/** Message persistant sous le bouton d'accès (un toast disparaît trop vite pour une consigne SMTP). */
function messageCompte(id, texte, couleur) {
  const el = $("#msg-compte");
  if (!el || etat.clientId !== id || etat.onglet !== "profil") return; // le coach a changé de fiche entre-temps
  el.className = `text-sm ${couleur}`;
  el.textContent = texte;
}

/** Invitation (fiche sans compte) ou lien de connexion (compte déjà rattaché) : même endpoint, l'API choisit. */
async function envoyerAcces(c, bouton) {
  bouton.disabled = true;
  messageCompte(c.id, "Envoi en cours…", "text-slate-400");
  let reponse;
  try {
    reponse = await api(`/coach/clients/${c.id}/invitation`, { methode: "POST" });
  } catch (err) {
    // 502 : envoi refusé par Supabase (SMTP non configuré, limite d'envoi…) ; 409 : e-mail pris par un autre compte
    bouton.disabled = false;
    messageCompte(c.id, messageErreurApi(err), "text-red-400");
    toast("L'e-mail n'a pas été envoyé : voir le détail dans la fiche.", "erreur");
    return;
  }
  const email = reponse?.email || c.email;
  const lien = reponse?.action === "lien_connexion";
  const texte = `${lien ? "Lien de connexion envoyé" : "Invitation envoyée"} à ${email}. En l'ouvrant, le client choisit`
    + " son mot de passe (lien valable peu de temps, à usage unique ; pensez aux courriers indésirables).";
  toast(lien ? "Lien de connexion envoyé." : "Invitation envoyée.", "ok");
  // Après une invitation, la fiche est rattachée au nouveau compte : le bouton devient « Renvoyer un lien »
  const reaffichee = await rafraichirFiche(c.id).catch(() => false);
  if (!reaffichee) bouton.disabled = false;
  messageCompte(c.id, texte, "text-emerald-400");
}

async function changerStatut(c, select) {
  const nouveau = select.value;
  if (nouveau === c.statut_abonnement) return toast("L'abonnement a déjà ce statut.", "info");
  if (c.statut_abonnement === "ACTIF"
    && !confirm(`Passer l'abonnement de ${c.nom} à « ${STATUTS[nouveau].nom} » ?\n\nLe client perdra l'accès à l'application.`)) {
    select.value = c.statut_abonnement;
    return;
  }
  // Aucune date envoyée par le navigateur : la date du changement (statut_modifie_le, revue de conservation)
  // est posée par un trigger en base, à l'heure du serveur. abonnement_maj_le n'est pas modifié : il garde
  // l'horodatage du dernier événement Systeme.io appliqué (ordre des événements).
  const lignes = await executer(supabase.from("clients").update({ statut_abonnement: nouveau }).eq("id", c.id).select("id"));
  if (!lignes.length) return toast("Fiche introuvable : elle a peut-être été supprimée.", "erreur");
  toast(`Abonnement de ${c.nom} : ${STATUTS[nouveau].nom}.`, "ok");
  await rafraichirFiche(c.id);
}

/** Retrait du consentement (RGPD art. 9) : efface les contraintes de santé et la date de consentement. */
async function effacerSante(c) {
  if (!confirm(`Effacer définitivement les contraintes de santé de ${c.nom} et la date de son consentement ?\n\n`
    + "À faire en cas de retrait du consentement : ces informations ne pourront pas être récupérées.")) return;
  const lignes = await executer(supabase.from("clients")
    .update({ contraintes_sante: null, consentement_sante_le: null }).eq("id", c.id).select("id"));
  if (!lignes.length) return toast("Fiche introuvable : elle a peut-être été supprimée.", "erreur");
  toast("Données de santé effacées.", "ok");
  await rafraichirFiche(c.id);
}

/** Mise à jour des contraintes de santé, possible seulement sous un consentement déjà enregistré. */
async function enregistrerSante(c, f) {
  if (!f.contraintes) return; // pas de champ sans consentement enregistré
  const texte = f.contraintes.value.trim();
  // Condition répétée en base : si le consentement a été retiré entre-temps (autre onglet), rien n'est écrit
  const lignes = await executer(supabase.from("clients").update({ contraintes_sante: texte || null })
    .eq("id", c.id).not("consentement_sante_le", "is", null).select("id"));
  if (!lignes.length) {
    toast("Rien n'a été enregistré : consentement retiré ou fiche supprimée entre-temps.", "erreur");
  } else {
    toast("Contraintes de santé enregistrées.", "ok");
  }
  await rafraichirFiche(c.id);
}

// Réponses du formulaire recopiées par « Reporter vers une autre fiche » (groupes indissociables)
const GROUPES_REPORT = [
  { cle: "nom", nom: "Nom", champs: ["nom"], apercu: (x) => x.nom },
  {
    cle: "objectifs", nom: "Objectifs", champs: ["target_kcal", "target_proteines", "target_glucides", "target_lipides"],
    apercu: (x) => `${x.target_kcal ?? "—"} kcal · P ${x.target_proteines ?? "—"} g · G ${x.target_glucides ?? "—"} g · L ${x.target_lipides ?? "—"} g`,
  },
  { cle: "jours", nom: "Jours de sport", champs: ["jours_sport"], apercu: (x) => joursDe(x).join(", ") || "—" },
  {
    // Les contraintes ne voyagent jamais sans la date d'origine du consentement (preuve, RGPD art. 9)
    cle: "sante", nom: "Contraintes de santé et date du consentement", champs: ["contraintes_sante", "consentement_sante_le"],
    present: (x) => !!x.contraintes_sante,
    apercu: (x) => (x.contraintes_sante
      ? `${x.contraintes_sante.length > 90 ? `${x.contraintes_sante.slice(0, 90)}…` : x.contraintes_sante}`
        + (x.consentement_sante_le ? ` (consentement du ${dateCourte(x.consentement_sante_le)})` : " (sans consentement)")
      : "—"),
  },
];
const COLONNES_REPORT = "id,nom,email,formulaire_recu_le,target_kcal,target_proteines,target_glucides,target_lipides,"
  + "jours_sport,contraintes_sante,consentement_sante_le";
const valeursGroupe = (g, x) => JSON.stringify(g.champs.map((k) => (k === "jours_sport" ? joursDe(x) : x[k] ?? null)));

/** Fiche en double (achat avec une adresse, formulaire avec une autre) : recopie les réponses du formulaire
 *  de la fiche en attente dans la fiche choisie (RLS coach), avant la suppression de la fiche en attente. */
function modaleReport(source) {
  const groupes = GROUPES_REPORT.filter((g) => !g.present || g.present(source));
  const autres = etat.clients.filter((x) => x.id !== source.id).sort((a, b) =>
    (a.statut_abonnement !== "ACTIF") - (b.statut_abonnement !== "ACTIF") || a.nom.localeCompare(b.nom, "fr"));
  const m = modale("Reporter vers une autre fiche", `
    <form id="form-report" class="space-y-3 text-sm">
      <p>Réponses au formulaire de <strong>${esc(source.nom)}</strong> (${esc(source.email)}) à recopier dans la fiche :</p>
      <select name="cible" class="champ" aria-label="Fiche de destination">
        <option value="">Choisir la fiche (en général celle de l'achat)…</option>
        ${autres.map((x) => `<option value="${x.id}">${esc(x.nom)} — ${esc(x.email)} (${esc(statutDe(x).nom)})</option>`).join("")}
      </select>
      <div id="groupes-report" class="space-y-2"></div>
      <p class="text-xs text-slate-400">Les valeurs cochées remplacent celles de la fiche choisie. La date de réception du
        formulaire est aussi reportée si la fiche choisie n'en a pas (elle n'acceptera alors plus de nouveau formulaire).
        Ne sont pas reportés : le compte de connexion (invitez le client depuis la fiche choisie), le programme,
        le journal et l'historique.</p>
      <button class="bouton w-full" disabled>Reporter</button>
      <p id="msg-report" role="alert"></p>
    </form>`);
  const f = $("#form-report", m.corps);
  const bouton = f.querySelector("button:not([type])");
  const msg = $("#msg-report", m.corps);
  const coches = () => groupes.filter((g) => f.querySelector(`[name="g-${g.cle}"]`)?.checked);
  const majBouton = () => { bouton.disabled = !f.cible.value || !coches().length; };
  f.cible.onchange = () => {
    const cible = etat.clients.find((x) => x.id === f.cible.value);
    $("#groupes-report", m.corps).innerHTML = !cible ? "" : groupes.map((g) => {
      const identique = valeursGroupe(g, source) === valeursGroupe(g, cible);
      return `<label class="flex gap-2 items-start rounded-lg bg-slate-800 px-3 py-2 ${identique ? "opacity-60" : ""}">
        <input type="checkbox" name="g-${g.cle}" class="mt-1" ${identique ? "disabled" : "checked"}>
        <span><strong>${g.nom}</strong>${identique ? " — identique" : ""}<br>
          <span class="text-slate-300">Fiche en attente : ${esc(g.apercu(source))}</span><br>
          <span class="text-slate-400">Fiche choisie, actuellement : ${esc(g.apercu(cible))}</span></span>
      </label>`;
    }).join("");
    f.querySelectorAll('[name^="g-"]').forEach((x) => (x.onchange = majBouton));
    msg.textContent = "";
    majBouton();
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const cibleId = f.cible.value, choisis = coches();
    if (!cibleId || !choisis.length || bouton.disabled) return;
    bouton.disabled = true;
    const echec = (texte) => { msg.className = "text-red-400"; msg.textContent = texte; majBouton(); };
    try {
      // Relecture des deux fiches : on recopie l'état actuel (des données effacées entre-temps ne doivent pas réapparaître)
      const fiches = await executer(supabase.from("clients").select(COLONNES_REPORT).in("id", [source.id, cibleId]));
      const src = fiches.find((x) => x.id === source.id), cib = fiches.find((x) => x.id === cibleId);
      if (!src || !cib) return echec("Une des deux fiches a été supprimée entre-temps : rien n'a été reporté.");
      const maj = {};
      for (const g of choisis) {
        if (g.present && !g.present(src)) {
          return echec(`${g.nom} : données effacées entre-temps sur la fiche en attente. Rien n'a été reporté.`);
        }
        g.champs.forEach((k) => { maj[k] = k === "jours_sport" ? joursDe(src) : src[k]; });
      }
      if (!cib.formulaire_recu_le && src.formulaire_recu_le) maj.formulaire_recu_le = src.formulaire_recu_le;
      const lignes = await executer(supabase.from("clients").update(maj).eq("id", cibleId).select("id"));
      if (!lignes.length) return echec("La fiche choisie a été supprimée entre-temps : rien n'a été reporté.");
      cib.nom = maj.nom ?? cib.nom; // nom éventuellement reporté
      toast(`Réponses reportées vers ${cib.nom}.`, "ok");
      await rafraichirFiche(source.id).catch(() => false);
      const aSupprimer = etat.clients.find((x) => x.id === source.id);
      m.corps.innerHTML = `
        <div class="space-y-3 text-sm">
          <p class="text-emerald-400">Réponses reportées vers <strong>${esc(cib.nom)}</strong> (${esc(cib.email)}).</p>
          <p>Étape suivante : supprimer la fiche en attente <strong>${esc(source.email)}</strong>, pour ne pas conserver
            ces données en double (données de santé comprises).</p>
          ${aSupprimer ? `<button id="report-suppr" class="bouton w-full !bg-red-600 hover:!bg-red-500 !text-white">Supprimer la fiche en attente…</button>` : ""}
          <button id="report-voir" class="bouton-sec w-full">Ouvrir la fiche de ${esc(cib.nom)}</button>
        </div>`;
      $("#report-suppr", m.corps)?.addEventListener("click", () => { m.fermer(); modaleSuppressionClient(aSupprimer); });
      $("#report-voir", m.corps).onclick = () => {
        m.fermer();
        etat.clientId = cib.id;
        etat.onglet = "profil";
        if ($("#page")) ouvrirPage("clients");
      };
    } catch {
      echec("Rien n'a été reporté (voir le message d'erreur).");
    }
  };
}

/** Droit à l'effacement : confirmation forte (saisie de l'e-mail), puis suppression par l'API (fiche + compte). */
function modaleSuppressionClient(c) {
  const m = modale("Supprimer le client", `
    <form id="form-suppr" class="space-y-3 text-sm">
      <p>Droit à l'effacement (RGPD) : cette action supprime <strong>définitivement</strong>, sans retour possible :</p>
      <ul class="list-disc pl-5 space-y-1 text-slate-300">
        <li>la fiche de <strong>${esc(c.nom)}</strong>, ses objectifs et ses contraintes de santé ;</li>
        <li>son journal alimentaire, son programme et l'historique de ses séances ;</li>
        <li>les redirections et les boutons qui lui sont propres ;</li>
        <li>son compte de connexion${c.user_id ? "" : " (aucun pour l'instant)"}.</li>
      </ul>
      <p class="text-amber-300">Rien n'est effacé hors de l'application : résiliez l'abonnement dans Systeme.io s'il est encore actif
        (et supprimez-y le contact en cas de demande d'effacement), supprimez sa réponse au formulaire Google Forms
        (et la feuille de réponses liée) ainsi que l'historique des scénarios Make.</p>
      <label class="block">Pour confirmer, saisissez l'e-mail du client (<strong>${esc(c.email)}</strong>) :
        <input name="confirmation" autocomplete="off" autocapitalize="off" spellcheck="false" class="champ mt-1"></label>
      <button class="bouton w-full !bg-red-600 hover:!bg-red-500 !text-white" disabled>Supprimer définitivement</button>
      <p id="msg-suppr" class="text-red-400" role="alert"></p>
    </form>`);
  const f = $("#form-suppr", m.corps);
  const bouton = f.querySelector("button:not([type])");
  const msg = $("#msg-suppr", m.corps);
  const confirme = () => f.confirmation.value.trim().toLowerCase() === String(c.email || "").trim().toLowerCase();
  f.confirmation.oninput = () => { bouton.disabled = !confirme(); };
  f.confirmation.focus();
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (!confirme() || bouton.disabled) return;
    bouton.disabled = true;
    msg.className = "text-slate-400";
    msg.textContent = "Suppression en cours…";
    try {
      await api(`/coach/clients/${c.id}`, { methode: "DELETE" });
      toast(`${c.nom} et toutes ses données ont été supprimés.`, "ok");
    } catch (err) {
      // 404 : fiche déjà supprimée (ailleurs) ; sinon rien n'a été effacé, on reste dans la modale
      let dejaSupprime = false;
      if (err.status === 404) {
        await chargerClients().catch(() => {});
        dejaSupprime = !etat.clients.some((x) => x.id === c.id);
      }
      if (!dejaSupprime) {
        msg.className = "text-red-400";
        msg.textContent = messageErreurApi(err);
        bouton.disabled = !confirme();
        return;
      }
      toast("Ce client avait déjà été supprimé.", "info");
    }
    m.fermer();
    etat.clientId = null;
    etat.onglet = "profil";
    if ($("#page")) ouvrirPage("clients");
  };
}

async function ongletProgramme() {
  const c = client();
  const seances = await executer(supabase.from("seances").select("*").eq("client_id", c.id).order("ordre"));
  const parJour = JOURS.map((j) => [j, seances.filter((s) => s.jour_semaine === j)]);
  $("#contenu").innerHTML = `
    <button id="ajout-seance" class="bouton mb-4">+ Ajouter une séance</button>
    <div class="grid sm:grid-cols-2 xl:grid-cols-4 gap-3">
      ${parJour.map(([jour, liste]) => `
        <div class="carte p-4">
          <h3 class="font-semibold mb-2">${jour}</h3>
          ${liste.map((s) => `
            <button data-seance="${s.id}" class="w-full text-left rounded-lg bg-slate-800 hover:bg-slate-700 px-3 py-2 mb-2">
              <div class="font-medium">${esc(s.titre)}</div>
              <div class="text-xs text-slate-400">${esc(s.duree || "")} ${s.video_url ? "· 🎬 vidéo" : ""}</div>
            </button>`).join("") || `<p class="text-sm text-slate-500">Repos</p>`}
        </div>`).join("")}
    </div>`;
  $("#ajout-seance").onclick = () => modaleSeance({ client_id: c.id, jour_semaine: "Lundi", ordre: 1 });
  $("#contenu").querySelectorAll("[data-seance]").forEach((b) =>
    (b.onclick = () => modaleSeance(seances.find((s) => s.id === b.dataset.seance))));
}

function modaleSeance(s) {
  const m = modale(s.id ? "Modifier la séance" : "Nouvelle séance", `
    <form id="form-seance" class="space-y-3">
      <input name="titre" required maxlength="200" placeholder="Titre (ex. Haut du corps)" class="champ" value="${esc(s.titre || "")}">
      <div class="grid grid-cols-2 gap-3">
        <label class="text-sm">Jour<select name="jour_semaine" class="champ mt-1">
          ${JOURS.map((j) => `<option ${j === s.jour_semaine ? "selected" : ""}>${j}</option>`).join("")}</select></label>
        <label class="text-sm">Ordre dans la journée<input name="ordre" type="number" min="1" max="20" class="champ mt-1" value="${s.ordre ?? 1}"></label>
      </div>
      <input name="duree" maxlength="50" placeholder="Durée (ex. 45 min)" class="champ" value="${esc(s.duree || "")}">
      <input name="video_url" type="url" placeholder="Lien de la vidéo (https://…)" class="champ" value="${esc(s.video_url || "")}">
      <div class="flex gap-2">
        <button class="bouton flex-1">Enregistrer</button>
        ${s.id ? `<button type="button" id="suppr-seance" class="bouton-sec !text-red-400">Supprimer</button>` : ""}
      </div>
    </form>`);
  $("#form-seance", m.corps).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const donnees = {
      client_id: s.client_id, titre: f.titre.value.trim(), jour_semaine: f.jour_semaine.value,
      ordre: +f.ordre.value || 1, duree: f.duree.value.trim() || null, video_url: f.video_url.value.trim() || null,
    };
    await executer(s.id ? supabase.from("seances").update(donnees).eq("id", s.id) : supabase.from("seances").insert(donnees),
      "Séance enregistrée.");
    m.fermer();
    ongletProgramme();
  };
  $("#suppr-seance", m.corps)?.addEventListener("click", async () => {
    if (!confirm(`Supprimer la séance « ${s.titre} » ? L'historique déjà réalisé est conservé.`)) return;
    await executer(supabase.from("seances").delete().eq("id", s.id), "Séance supprimée.");
    m.fermer();
    ongletProgramme();
  });
}

async function ongletHistorique() {
  const depuis = decalerJours(isoLocal(new Date()), -60);
  const lignes = await executer(supabase.from("seances_realisees")
    .select("date_realisee,titre,statut,ressenti,commentaire").eq("client_id", etat.clientId)
    .gte("date_realisee", depuis).order("date_realisee", { ascending: false }));
  const faites = lignes.filter((l) => l.statut === "FAIT").length;
  $("#contenu").innerHTML = `
    <p class="mb-3 text-sm text-slate-400">60 derniers jours : <strong class="text-white">${faites}</strong> séance(s) faite(s),
      <strong class="text-white">${lignes.length - faites}</strong> manquée(s).</p>
    <div class="carte divide-y divide-slate-800">
      ${lignes.map((l) => `
        <div class="px-4 py-3 flex flex-wrap gap-x-4 gap-y-1 items-baseline">
          <span class="w-28 text-sm text-slate-400">${new Date(l.date_realisee + "T12:00:00").toLocaleDateString("fr-FR")}</span>
          <span class="font-medium">${esc(l.titre)}</span>
          <span class="text-sm ${l.statut === "FAIT" ? "text-emerald-400" : "text-slate-400"}">${l.statut === "FAIT" ? "faite" : "manquée"}</span>
          ${l.ressenti ? `<span class="text-sm">${["😫", "😕", "😐", "🙂", "💪"][l.ressenti - 1]}</span>` : ""}
          ${l.commentaire ? `<p class="w-full text-sm text-slate-300">« ${esc(l.commentaire)} »</p>` : ""}
        </div>`).join("") || `<p class="px-4 py-3 text-sm text-slate-500">Aucune séance enregistrée.</p>`}
    </div>`;
}

async function ongletJournal() {
  const jour = etat.jourJournal;
  const repas = await executer(supabase.from("journal_repas")
    .select("id,type_repas,target_kcal,consigne_coach,aliments_scannes(nom_aliment,quantite_g,kcal,proteines,glucides,lipides,est_estimation)")
    .eq("client_id", etat.clientId).eq("date_repas", jour));
  const parType = Object.fromEntries(repas.map((r) => [r.type_repas, r]));
  const total = repas.flatMap((r) => r.aliments_scannes).reduce((t, a) => t + a.kcal, 0);
  $("#contenu").innerHTML = `
    <div class="flex items-center gap-3 mb-4">
      <button id="j-prec" class="bouton-sec">‹</button>
      <span class="font-semibold capitalize">${esc(dateLisible(jour))}</span>
      <button id="j-suiv" class="bouton-sec">›</button>
      <span class="ml-auto text-sm text-slate-400">Total : <strong class="text-white">${total}</strong> / ${client().target_kcal} kcal</span>
    </div>
    <div class="grid md:grid-cols-2 gap-3">
      ${REPAS.map(([type, nom]) => {
        const r = parType[type] || {}, aliments = r.aliments_scannes || [];
        return `
        <form data-repas="${type}" class="carte p-4 space-y-2">
          <div class="flex justify-between"><h3 class="font-semibold">${nom}</h3>
            <span class="text-sm text-slate-400">${aliments.reduce((t, a) => t + a.kcal, 0)} kcal</span></div>
          <ul class="text-sm text-slate-300">
            ${aliments.map((a) => `<li>• ${esc(a.nom_aliment)} ${a.quantite_g ? `(${a.quantite_g} g)` : ""} — ${a.kcal} kcal
              ${a.est_estimation ? `<span class="pastille-estimation">estimation</span>` : ""}</li>`).join("") || `<li class="text-slate-500">Rien de saisi</li>`}
          </ul>
          <textarea name="consigne" rows="2" maxlength="500" placeholder="Consigne pour ce repas" class="champ text-sm">${esc(r.consigne_coach || "")}</textarea>
          <div class="flex gap-2 items-center">
            <label class="text-sm flex items-center gap-2">Objectif<input name="cible" type="number" min="0" max="5000" class="champ !w-24 text-sm" value="${r.target_kcal || ""}"> kcal</label>
            <button class="bouton-sec text-sm ml-auto">Enregistrer</button>
          </div>
        </form>`;
      }).join("")}
    </div>`;
  $("#j-prec").onclick = () => { etat.jourJournal = decalerJours(jour, -1); ongletJournal(); };
  $("#j-suiv").onclick = () => { etat.jourJournal = decalerJours(jour, 1); ongletJournal(); };
  $("#contenu").querySelectorAll("[data-repas]").forEach((f) => (f.onsubmit = async (e) => {
    e.preventDefault();
    await executer(supabase.from("journal_repas").upsert({
      client_id: etat.clientId, date_repas: jour, type_repas: f.dataset.repas,
      consigne_coach: f.consigne.value.trim() || null, target_kcal: +f.cible.value || 0,
    }, { onConflict: "client_id,date_repas,type_repas" }), "Consigne enregistrée.");
  }));
}

// ---------------------------------------------------------------------------
// Règles de redirection et boutons (globaux ou propres à un client)
// ---------------------------------------------------------------------------
const TYPES_CIBLE = [["ECRAN", "Écran de l'app"], ["URL", "Lien web"], ["VIDEO", "Vidéo"]];
const CONFIG_REGLES = {
  table: "regles_redirection", titre: "Redirections après une séance",
  aide: "Après la validation d'une séance, le client est redirigé vers la cible de la règle la plus précise (client + séance > client > séance > toutes). Écrans possibles : nutrition, sport.",
  colonnes: "id,client_id,seance_id,declencheur,cible_type,cible,priorite,actif",
  resume: (r) => `${({ SEANCE_VALIDEE: "Séance faite", SEANCE_MANQUEE: "Séance manquée", REPAS_VALIDE: "Repas validé" })[r.declencheur]} → ${r.cible_type} : ${r.cible}`,
  champs: (r) => `
    <label class="text-sm block">Déclencheur<select name="declencheur" class="champ mt-1">
      ${[["SEANCE_VALIDEE", "Séance faite"], ["SEANCE_MANQUEE", "Séance manquée"]].map(([v, n]) => `<option value="${v}" ${r.declencheur === v ? "selected" : ""}>${n}</option>`).join("")}
    </select></label>
    <label class="text-sm block">Priorité (1 = la plus forte)<input name="priorite" type="number" min="1" max="100" class="champ mt-1" value="${r.priorite ?? 1}"></label>`,
  lire: (f) => ({ declencheur: f.declencheur.value, priorite: +f.priorite.value || 1 }),
};
const CONFIG_BOUTONS = {
  table: "boutons_actions", titre: "Boutons d'action",
  aide: "Boutons affichés dans l'application client. Emplacements : ACCUEIL (partout), NUTRITION, SPORT.",
  colonnes: "id,client_id,emplacement,libelle,action_type,cible,ordre,actif",
  resume: (b) => `[${b.emplacement}] « ${b.libelle} » → ${b.action_type} : ${b.cible}`,
  champs: (b) => `
    <input name="libelle" required maxlength="60" placeholder="Texte du bouton" class="champ" value="${esc(b.libelle || "")}">
    <div class="grid grid-cols-2 gap-3">
      <label class="text-sm">Emplacement<select name="emplacement" class="champ mt-1">
        ${["ACCUEIL", "NUTRITION", "SPORT"].map((e) => `<option ${b.emplacement === e ? "selected" : ""}>${e}</option>`).join("")}</select></label>
      <label class="text-sm">Ordre<input name="ordre" type="number" min="1" max="100" class="champ mt-1" value="${b.ordre ?? 1}"></label>
    </div>`,
  lire: (f) => ({ libelle: f.libelle.value.trim(), emplacement: f.emplacement.value, ordre: +f.ordre.value || 1 }),
  cible: "action_type",
};

async function pageConfiguration(cfg) {
  if (!etat.clients.length) await chargerClients();
  const lignes = await executer(supabase.from(cfg.table).select(cfg.colonnes).order("created_at"));
  const nomClient = (id) => (id ? etat.clients.find((c) => c.id === id)?.nom || "client supprimé" : "Tous les clients");
  $("#page").innerHTML = `
    <h2 class="text-2xl font-bold mb-1">${cfg.titre}</h2>
    <p class="text-sm text-slate-400 mb-4 max-w-3xl">${cfg.aide}</p>
    <button id="ajout" class="bouton mb-4">+ Ajouter</button>
    <div class="carte divide-y divide-slate-800">
      ${lignes.map((l) => `
        <button data-ligne="${l.id}" class="w-full text-left px-4 py-3 hover:bg-slate-800 flex justify-between gap-3">
          <span>${esc(cfg.resume(l))}</span>
          <span class="text-sm text-slate-400 shrink-0">${esc(nomClient(l.client_id))} ${l.actif ? "" : "· désactivé"}</span>
        </button>`).join("") || `<p class="px-4 py-3 text-sm text-slate-500">Aucun élément.</p>`}
    </div>`;
  $("#ajout").onclick = () => modaleConfiguration(cfg, { actif: true });
  $("#page").querySelectorAll("[data-ligne]").forEach((b) =>
    (b.onclick = () => modaleConfiguration(cfg, lignes.find((l) => l.id === b.dataset.ligne))));
}

/** Options de la liste « Séance concernée » : séances du client choisi (aucune pour « Tous les clients »). */
async function optionsSeances(clientId, seanceId) {
  const seances = clientId
    ? await executer(supabase.from("seances").select("id,titre,jour_semaine,ordre").eq("client_id", clientId)) : [];
  seances.sort((a, b) => JOURS.indexOf(a.jour_semaine) - JOURS.indexOf(b.jour_semaine) || (a.ordre ?? 1) - (b.ordre ?? 1));
  return `<option value="">Toutes les séances</option>
    ${seances.map((s) => `<option value="${s.id}" ${s.id === seanceId ? "selected" : ""}>${esc(s.jour_semaine)} — ${esc(s.titre)}</option>`).join("")}`;
}

async function modaleConfiguration(cfg, l) {
  const champCible = cfg.cible || "cible_type";
  const avecSeances = cfg.table === "regles_redirection";
  const options = avecSeances ? await optionsSeances(l.client_id, l.seance_id) : "";
  const m = modale(l.id ? "Modifier" : "Ajouter", `
    <form id="form-cfg" class="space-y-3">
      <label class="text-sm block">Pour<select name="client_id" class="champ mt-1">
        <option value="">Tous les clients</option>
        ${etat.clients.map((c) => `<option value="${c.id}" ${c.id === l.client_id ? "selected" : ""}>${esc(c.nom)}</option>`).join("")}
      </select></label>
      ${avecSeances ? `
        <label class="text-sm block">Séance concernée<select name="seance_id" class="champ mt-1">${options}</select></label>` : ""}
      ${cfg.champs(l)}
      <div class="grid grid-cols-2 gap-3">
        <label class="text-sm">Type de cible<select name="type_cible" class="champ mt-1">
          ${TYPES_CIBLE.map(([v, n]) => `<option value="${v}" ${l[champCible] === v ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <label class="text-sm">Cible<input name="cible" required maxlength="500" placeholder="nutrition, sport ou https://…" class="champ mt-1" value="${esc(l.cible || "")}"></label>
      </div>
      <label class="text-sm flex items-center gap-2"><input type="checkbox" name="actif" ${l.actif ? "checked" : ""}> Actif</label>
      <div class="flex gap-2">
        <button class="bouton flex-1">Enregistrer</button>
        ${l.id ? `<button type="button" id="suppr-cfg" class="bouton-sec !text-red-400">Supprimer</button>` : ""}
      </div>
    </form>`);
  const f = $("#form-cfg", m.corps);
  // La liste des séances dépend du client choisi : seule elle est rechargée, le reste de la saisie
  // (déclencheur, priorité, type de cible, cible, actif…) est conservé tel quel.
  if (avecSeances) {
    let dernierChoix = 0;
    f.client_id.onchange = async () => {
      const choix = ++dernierChoix;
      const clientId = f.client_id.value || null;
      f.seance_id.disabled = true;
      let html;
      try {
        // Retour au client d'origine : la séance déjà enregistrée est resélectionnée
        html = await optionsSeances(clientId, clientId === l.client_id ? l.seance_id : null);
      } catch {
        html = `<option value="">Toutes les séances</option>`; // erreur déjà affichée par executer
      }
      if (choix !== dernierChoix) return; // un autre client a été choisi pendant le chargement
      f.seance_id.innerHTML = html;
      f.seance_id.disabled = false;
    };
  }
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (avecSeances && f.seance_id.disabled) return toast("Chargement des séances du client en cours…", "info");
    const cible = f.cible.value.trim();
    if (f.type_cible.value !== "ECRAN" && !/^https?:\/\//i.test(cible))
      return toast("Pour un lien ou une vidéo, la cible doit commencer par https://", "erreur");
    const donnees = {
      ...cfg.lire(f), client_id: f.client_id.value || null, [champCible]: f.type_cible.value,
      cible, actif: f.actif.checked,
      ...(avecSeances ? { seance_id: f.seance_id.value || null } : {}),
    };
    await executer(l.id ? supabase.from(cfg.table).update(donnees).eq("id", l.id) : supabase.from(cfg.table).insert(donnees), "Enregistré.");
    m.fermer();
    pageConfiguration(cfg);
  };
  $("#suppr-cfg", m.corps)?.addEventListener("click", async () => {
    if (!confirm("Supprimer cet élément ?")) return;
    await executer(supabase.from(cfg.table).delete().eq("id", l.id), "Supprimé.");
    m.fermer();
    pageConfiguration(cfg);
  });
}

demarrer();
