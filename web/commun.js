// Outils partagés par l'application client et l'espace coach.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config.js";

// Lien d'invitation ou de réinitialisation : à lire AVANT que supabase-js ne nettoie l'URL
const PARAMS_LIEN = new URLSearchParams(location.hash.slice(1));
export const TYPE_LIEN = PARAMS_LIEN.get("type");

// Lien expiré, déjà utilisé ou invalide : Supabase revient avec error / error_code / error_description
// (dans le fragment en flux implicite, dans la requête en flux PKCE), sans « type ».
// error_description n'est jamais affiché tel quel (il peut être forgé) : le code est traduit en message fixe.
const PARAMS_REQUETE = new URLSearchParams(location.search);
const CODE_ERREUR_LIEN = ["error_code", "error"]
  .map((cle) => PARAMS_LIEN.get(cle) || PARAMS_REQUETE.get(cle)).find(Boolean) || null;
export const ERREUR_LIEN = !CODE_ERREUR_LIEN ? null
  : ["otp_expired", "access_denied"].includes(CODE_ERREUR_LIEN) ? "Ce lien a expiré ou a déjà été utilisé."
  : "Ce lien n'est pas valide.";
let erreurLienAffichee = false;

// Accès au localStorage : il peut être indisponible (navigation privée, stockage bloqué)
function stockage(action) {
  try { return action(localStorage); } catch { return null; }
}

// Mot de passe à définir après une invitation ou une réinitialisation. supabase-js enregistre la session
// et efface le lien dès le chargement : sans ce marqueur, recharger la page ou fermer l'onglet sautait
// l'écran « Choisissez votre mot de passe » et laissait un compte sans mot de passe.
const CLE_MDP_A_DEFINIR = "sportoop_mdp_a_definir";
if (TYPE_LIEN === "invite" || TYPE_LIEN === "recovery") stockage((s) => s.setItem(CLE_MDP_A_DEFINIR, TYPE_LIEN));
export const motDePasseADefinir = () =>
  TYPE_LIEN === "invite" || TYPE_LIEN === "recovery" || Boolean(stockage((s) => s.getItem(CLE_MDP_A_DEFINIR)));
export const oublierMotDePasseADefinir = () => stockage((s) => s.removeItem(CLE_MDP_A_DEFINIR));

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

export const $ = (sel, racine = document) => racine.querySelector(sel);

/** Échappe le texte avant insertion en HTML (les noms d'aliments viennent des utilisateurs ou de l'IA). */
export function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Action appelée quand Supabase confirme que la session est refusée (expirée, révoquée, compte supprimé).
// Aucune par défaut.
let surNonAuthentifie = null;
export function quandNonAuthentifie(action) {
  surNonAuthentifie = action;
}

// Échec passager côté Supabase Auth : pas de réponse (réseau, délai), 5xx (AuthRetryableFetchError),
// réponse illisible (AuthUnknownError, sans statut) ou limite de débit. La session ne doit pas être oubliée.
const erreurPassagere = (error) => !error.status || error.status >= 500 || error.status === 429 || error.status === 408;

/** Erreur renvoyée quand l'identité n'a pas pu être vérifiée faute de réponse de Supabase. */
function erreurIndisponible() {
  const erreur = new Error("Le service est momentanément indisponible. Réessayez dans quelques instants.");
  erreur.status = 503;
  erreur.code = "indisponible";
  return erreur;
}

/**
 * Le 401 de l'API ne suffit pas à conclure : le backend répond aussi 401 quand SA requête vers
 * Supabase Auth échoue (délai, 5xx, réseau Railway → Supabase). On demande donc directement à
 * Supabase : seul un refus explicite (4xx, session supprimée) justifie de déconnecter le client.
 * Les vérifications simultanées (plusieurs appels en échec) partagent la même requête.
 */
let verificationEnCours = null;
function sessionRefuseeParSupabase() {
  if (!verificationEnCours) {
    verificationEnCours = (async () => {
      const { data, error } = await supabase.auth.getUser().catch((err) => ({ data: {}, error: err }));
      if (!error) return !data?.user;
      return !erreurPassagere(error); // 4xx, AuthSessionMissingError (session supprimée côté serveur)
    })().finally(() => { verificationEnCours = null; });
  }
  return verificationEnCours;
}

/** Appel à l'API FastAPI (même domaine) avec le jeton de la session Supabase. */
export async function api(chemin, { methode = "GET", json, formData } = {}) {
  const { data, error: erreurSession } = await supabase.auth.getSession();
  // Jeton expiré dont le rafraîchissement vient d'échouer faute de réponse de Supabase : supabase-js
  // garde la session, mais renvoie null. Appeler l'API sans jeton donnerait un 401 et une déconnexion à tort.
  if (!data.session && erreurSession && erreurPassagere(erreurSession)) throw erreurIndisponible();
  const entetes = {};
  if (data.session) entetes.Authorization = `Bearer ${data.session.access_token}`;
  let corps;
  if (json !== undefined) {
    entetes["Content-Type"] = "application/json";
    corps = JSON.stringify(json);
  } else if (formData) {
    corps = formData;
  }
  const r = await fetch(chemin, { method: methode, headers: entetes, body: corps });
  if (r.status === 204) return null;
  const contenu = await r.json().catch(() => ({}));
  if (!r.ok) {
    const d = contenu.detail;
    const objet = d && typeof d === "object" && !Array.isArray(d);
    const detail = Array.isArray(d) ? d.map((x) => x.msg).join(" ; ")
      : objet ? d.message || d.msg || `Erreur ${r.status}`
      : d || `Erreur ${r.status}`;
    const erreur = new Error(detail);
    erreur.status = r.status;
    erreur.code = (objet && d.code) || contenu.code || null;
    if (r.status === 401) {
      // Supabase ne confirme pas le refus : incident passager (côté serveur ou Supabase), session conservée
      if (!(await sessionRefuseeParSupabase())) throw erreurIndisponible();
      if (surNonAuthentifie) surNonAuthentifie(erreur);
    }
    throw erreur;
  }
  return contenu;
}

let minuteurToast;
export function toast(message, type = "info") {
  let el = $("#toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-3 rounded-xl text-sm shadow-lg max-w-[90vw] transition-opacity";
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.remove("opacity-0", "bg-red-600", "bg-emerald-600", "bg-slate-700");
  el.classList.add(type === "erreur" ? "bg-red-600" : type === "ok" ? "bg-emerald-600" : "bg-slate-700");
  clearTimeout(minuteurToast);
  minuteurToast = setTimeout(() => el.classList.add("opacity-0"), 3500);
}

/** Fenêtre modale simple : renvoie l'élément conteneur ; fermer() la retire. */
export function modale(titre, html) {
  const fond = document.createElement("div");
  fond.className = "fixed inset-0 z-40 bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4";
  fond.innerHTML = `
    <div class="bg-slate-900 border border-slate-700 w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl max-h-[92vh] overflow-y-auto">
      <div class="flex items-center justify-between px-5 py-4 border-b border-slate-800 sticky top-0 bg-slate-900">
        <h2 class="font-semibold text-lg">${esc(titre)}</h2>
        <button data-fermer class="text-slate-400 hover:text-white text-2xl leading-none" aria-label="Fermer">&times;</button>
      </div>
      <div class="p-5" data-corps>${html}</div>
    </div>`;
  const fermer = () => fond.remove();
  fond.addEventListener("click", (e) => { if (e.target === fond || e.target.closest("[data-fermer]")) fermer(); });
  document.body.append(fond);
  return { el: fond, corps: $("[data-corps]", fond), fermer };
}

const COULEURS_MESSAGE = { erreur: "text-red-400", ok: "text-emerald-400", info: "text-amber-300" };
function afficherMessage(el, texte, type = "erreur") {
  el.classList.remove(...Object.values(COULEURS_MESSAGE));
  el.classList.add(COULEURS_MESSAGE[type]);
  el.textContent = texte;
}

// Erreur réseau : aucune réponse HTTP du serveur Supabase (statut 0). Les 5xx, que supabase-js
// classe aussi en AuthRetryableFetchError, ont un statut et reçoivent un message distinct.
const erreurReseau = (error) => !error.status;

/** Message honnête quand Supabase refuse d'envoyer l'e-mail de réinitialisation. */
function messageEchecEnvoi(error) {
  if (error.status === 429 || String(error.code || "").includes("rate_limit"))
    return "Trop de demandes d'e-mail en peu de temps : réessayez dans quelques minutes.";
  if (erreurReseau(error)) return "Connexion impossible : vérifiez votre réseau puis réessayez.";
  return "L'e-mail n'a pas pu être envoyé pour le moment. Réessayez plus tard ou contactez votre coach.";
}

function messageEchecConnexion(error) {
  if (error.code === "email_not_confirmed")
    return "Adresse e-mail non confirmée : utilisez le lien reçu par e-mail ou « Mot de passe oublié ? ».";
  if (error.status === 429) return "Trop de tentatives : réessayez dans quelques minutes.";
  if (erreurReseau(error)) return "Connexion impossible : vérifiez votre réseau puis réessayez.";
  if (error.status === 400 || error.code === "invalid_credentials") return "E-mail ou mot de passe incorrect.";
  return "Connexion impossible pour le moment. Réessayez dans quelques instants.";
}

/**
 * Écran de connexion (+ mot de passe oublié). Résout quand l'utilisateur est connecté.
 * `message` : explication facultative affichée à l'ouverture (ex. session expirée).
 */
export function ecranConnexion(conteneur, titre, { message = "" } = {}) {
  return new Promise((resoudre) => {
    conteneur.innerHTML = `
      <div class="min-h-screen flex items-center justify-center p-6">
        <form class="w-full max-w-sm space-y-4 bg-slate-900 border border-slate-800 rounded-2xl p-6" id="form-connexion">
          <h1 class="text-2xl font-bold text-center">${esc(titre)}</h1>
          <input name="email" type="email" required autocomplete="email" placeholder="E-mail" class="champ">
          <input name="mdp" type="password" required autocomplete="current-password" placeholder="Mot de passe" class="champ">
          <button class="bouton w-full">Se connecter</button>
          <button type="button" id="mdp-oublie" class="w-full text-sm text-slate-400 hover:text-white">Mot de passe oublié ?</button>
          <p id="msg-connexion" class="text-sm text-center text-red-400"></p>
        </form>
      </div>`;
    const form = $("#form-connexion", conteneur);
    const msg = $("#msg-connexion", conteneur);
    if (ERREUR_LIEN && !erreurLienAffichee) {
      // Lien d'invitation ou de réinitialisation expiré / déjà utilisé : le client n'a souvent pas de mot de passe
      erreurLienAffichee = true;
      afficherMessage(msg, `${ERREUR_LIEN} Saisissez votre e-mail puis touchez « Mot de passe oublié ? » pour recevoir un nouveau lien.`, "info");
      history.replaceState(null, "", location.pathname);
    } else if (message) {
      afficherMessage(msg, message, "info");
    }
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const bouton = form.querySelector("button:not([type])");
      bouton.disabled = true;
      const { error } = await supabase.auth.signInWithPassword({ email: form.email.value.trim(), password: form.mdp.value })
        .catch((err) => ({ error: err }));
      bouton.disabled = false;
      if (error) return afficherMessage(msg, messageEchecConnexion(error));
      oublierMotDePasseADefinir(); // connexion par mot de passe réussie : il en existe bien un
      resoudre();
    });
    $("#mdp-oublie", conteneur).addEventListener("click", async (e) => {
      const email = form.email.value.trim();
      if (!email) return afficherMessage(msg, "Saisissez d'abord votre e-mail.");
      if (!form.email.checkValidity()) return afficherMessage(msg, "Adresse e-mail invalide.");
      const bouton = e.currentTarget;
      bouton.disabled = true;
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname })
        .catch((err) => ({ error: err }));
      bouton.disabled = false;
      // Message neutre en cas de succès : ne pas révéler si un compte existe pour cette adresse
      if (error) afficherMessage(msg, messageEchecEnvoi(error));
      else afficherMessage(msg, "Si un compte existe pour cette adresse, un e-mail de réinitialisation vient d'être envoyé (pensez aux indésirables).", "ok");
    });
  });
}

/** Après un lien d'invitation / de réinitialisation : choix du mot de passe (non contournable, voir motDePasseADefinir). */
export function ecranNouveauMotDePasse(conteneur) {
  return new Promise((resoudre) => {
    conteneur.innerHTML = `
      <div class="min-h-screen flex items-center justify-center p-6">
        <form class="w-full max-w-sm space-y-4 bg-slate-900 border border-slate-800 rounded-2xl p-6" id="form-mdp">
          <h1 class="text-xl font-bold text-center">Choisissez votre mot de passe</h1>
          <input name="mdp" type="password" required minlength="8" autocomplete="new-password" placeholder="8 caractères minimum" class="champ">
          <button class="bouton w-full">Enregistrer</button>
          <p id="msg-mdp" class="text-sm text-center text-red-400"></p>
          <button type="button" id="retour-connexion" class="hidden w-full text-sm text-slate-400 hover:text-white">Retour à la connexion</button>
        </form>
      </div>`;
    const form = $("#form-mdp", conteneur);
    const msg = $("#msg-mdp", conteneur);
    $("#retour-connexion", conteneur).addEventListener("click", async () => {
      oublierMotDePasseADefinir();
      await supabase.auth.signOut({ scope: "local" }).catch(() => {});
      location.replace(location.pathname);
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const bouton = form.querySelector("button:not([type])");
      bouton.disabled = true;
      const { error } = await supabase.auth.updateUser({ password: form.mdp.value }).catch((err) => ({ error: err }));
      bouton.disabled = false;
      if (!error) {
        oublierMotDePasseADefinir();
        history.replaceState(null, "", location.pathname);
        return resoudre();
      }
      if (error.name === "AuthSessionMissingError" || error.status === 401 || error.status === 403 || error.code === "session_not_found") {
        // La session ouverte par le lien n'est plus valide : il faut un nouveau lien
        afficherMessage(msg, "Votre lien n'est plus valide. Revenez à la connexion et utilisez « Mot de passe oublié ? » pour en recevoir un nouveau.");
        $("#retour-connexion", conteneur).classList.remove("hidden");
      } else if (error.code === "same_password") {
        afficherMessage(msg, "Ce mot de passe est identique à l'ancien : choisissez-en un autre.");
      } else if (error.code === "weak_password" || error.status === 422) {
        afficherMessage(msg, "Mot de passe refusé (trop simple ou déjà compromis). Choisissez-en un autre.");
      } else if (erreurReseau(error)) {
        afficherMessage(msg, "Connexion impossible : vérifiez votre réseau puis réessayez.");
      } else {
        afficherMessage(msg, "Impossible d'enregistrer le mot de passe pour le moment. Réessayez dans quelques instants.");
      }
    });
  });
}

export async function sessionCourante() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

/**
 * Session locale et disponibilité de Supabase Auth. `indisponible` : le jeton a expiré et son
 * rafraîchissement a échoué faute de réponse (réseau, panne) ; la session est conservée par
 * supabase-js, il ne faut donc pas présenter l'écran de connexion comme si elle était perdue.
 */
export async function etatSession() {
  const { data, error } = await supabase.auth.getSession().catch((err) => ({ data: {}, error: err }));
  const session = data?.session || null;
  return { session, indisponible: !session && Boolean(error) && erreurPassagere(error) };
}

// Dates au format AAAA-MM-JJ en heure locale
export const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const decalerJours = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return isoLocal(d); };
export const dateLisible = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });

// « Aujourd'hui » pour le client : sa journée locale. C'est elle qui date le journal alimentaire
// (le serveur n'impose aucune date pour la nutrition) et qui est mise en évidence dans le programme.
export const aujourdhuiLocal = () => isoLocal(new Date());

// « Aujourd'hui » au sens du serveur (FUSEAU = Europe/Paris dans app/constantes.py). À n'utiliser QUE pour
// prévoir le contrôle « séance future » de POST /seances/{id}/validation : pour tout le reste, un client
// hors métropole (Antilles, Polynésie, Nouvelle-Calédonie…) changerait de jour à minuit heure de Paris.
let formatJourParis = null;
try {
  formatJourParis = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" });
} catch { /* fuseau inconnu du navigateur : repli sur l'heure locale */ }
export function aujourdhuiServeur() {
  if (!formatJourParis) return aujourdhuiLocal();
  const p = Object.fromEntries(formatJourParis.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
