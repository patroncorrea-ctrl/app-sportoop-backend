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
const racine = $("#app");
const etat = { clients: [], clientId: null, onglet: "profil", recherche: "", jourJournal: isoLocal(new Date()) };

async function executer(requete, messageOk) {
  const { data, error } = await requete;
  if (error) { toast(`Erreur : ${error.message}`, "erreur"); throw error; }
  if (messageOk) toast(messageOk, "ok");
  return data;
}

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
  etat.clients = await executer(supabase.from("clients")
    .select("id,nom,email,user_id,statut_abonnement,target_kcal,target_proteines,target_glucides,target_lipides,jours_sport,contraintes_sante,consentement_sante_le,created_at")
    .order("nom"));
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
      <div class="font-medium">${esc(c.nom)} ${c.statut_abonnement === "RESILIE" ? `<span class="text-xs text-rose-400">résilié</span>` : ""}</div>
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
        <h3 class="font-semibold">Objectifs quotidiens</h3>
        <div class="grid grid-cols-2 gap-3">
          ${[["target_kcal", "Kcal"], ["target_proteines", "Protéines (g)"], ["target_glucides", "Glucides (g)"], ["target_lipides", "Lipides (g)"]]
            .map(([cle, nom]) => `<label class="text-sm">${nom}<input name="${cle}" type="number" min="0" max="10000" required class="champ mt-1" value="${c[cle] ?? ""}"></label>`).join("")}
        </div>
        <label class="text-sm block">Nom<input name="nom" required maxlength="200" class="champ mt-1" value="${esc(c.nom)}"></label>
        <button class="bouton w-full">Enregistrer</button>
      </form>
      <div class="carte p-5 space-y-3 text-sm">
        <h3 class="font-semibold text-base">Compte & abonnement</h3>
        <p>Abonnement : <strong class="${c.statut_abonnement === "RESILIE" ? "text-rose-400" : "text-emerald-400"}">${c.statut_abonnement === "RESILIE" ? "résilié" : "actif"}</strong></p>
        <p>Compte de connexion : ${c.user_id ? `<strong class="text-emerald-400">créé</strong>`
          : `<strong class="text-amber-400">pas encore créé</strong> <button id="inviter" class="bouton text-sm ml-2">Envoyer l'invitation</button>`}</p>
        <p>Jours de sport : ${esc((c.jours_sport || []).join(", ") || "—")}</p>
        <div>
          <p class="text-slate-400">Contraintes de santé ${c.consentement_sante_le ? "" : `<span class="text-amber-400">(consentement non enregistré)</span>`}</p>
          <p class="whitespace-pre-wrap">${esc(c.contraintes_sante || "—")}</p>
        </div>
      </div>
    </div>`;
  $("#form-obj").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    await executer(supabase.from("clients").update({
      nom: f.nom.value.trim(), target_kcal: +f.target_kcal.value, target_proteines: +f.target_proteines.value,
      target_glucides: +f.target_glucides.value, target_lipides: +f.target_lipides.value,
    }).eq("id", c.id), "Objectifs enregistrés.");
    await chargerClients();
    listeClients();
    ficheClient();
  };
  $("#inviter")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      await api(`/coach/clients/${c.id}/invitation`, { methode: "POST" });
      toast(`Invitation envoyée à ${c.email}.`, "ok");
      await chargerClients();
      ficheClient();
    } catch (err) {
      toast(err.message, "erreur");
      e.target.disabled = false;
    }
  });
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

async function modaleConfiguration(cfg, l) {
  const champCible = cfg.cible || "cible_type";
  const seances = l.client_id
    ? await executer(supabase.from("seances").select("id,titre,jour_semaine").eq("client_id", l.client_id)) : [];
  const m = modale(l.id ? "Modifier" : "Ajouter", `
    <form id="form-cfg" class="space-y-3">
      <label class="text-sm block">Pour<select name="client_id" class="champ mt-1">
        <option value="">Tous les clients</option>
        ${etat.clients.map((c) => `<option value="${c.id}" ${c.id === l.client_id ? "selected" : ""}>${esc(c.nom)}</option>`).join("")}
      </select></label>
      ${cfg.table === "regles_redirection" ? `
        <label class="text-sm block">Séance concernée<select name="seance_id" class="champ mt-1">
          <option value="">Toutes les séances</option>
          ${seances.map((s) => `<option value="${s.id}" ${s.id === l.seance_id ? "selected" : ""}>${esc(s.jour_semaine)} — ${esc(s.titre)}</option>`).join("")}
        </select></label>` : ""}
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
  // La liste des séances dépend du client choisi
  f.client_id.onchange = () => { m.fermer(); modaleConfiguration(cfg, { ...l, ...cfg.lire(f), client_id: f.client_id.value || null, seance_id: null }); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const cible = f.cible.value.trim();
    if (f.type_cible.value !== "ECRAN" && !/^https?:\/\//i.test(cible))
      return toast("Pour un lien ou une vidéo, la cible doit commencer par https://", "erreur");
    const donnees = {
      ...cfg.lire(f), client_id: f.client_id.value || null, [champCible]: f.type_cible.value,
      cible, actif: f.actif.checked,
      ...(cfg.table === "regles_redirection" ? { seance_id: f.seance_id.value || null } : {}),
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
