// Outils partagés par l'application client et l'espace coach.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config.js";

// Lien d'invitation ou de réinitialisation : à lire AVANT que supabase-js ne nettoie l'URL
export const TYPE_LIEN = new URLSearchParams(location.hash.slice(1)).get("type");

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

export const $ = (sel, racine = document) => racine.querySelector(sel);

/** Échappe le texte avant insertion en HTML (les noms d'aliments viennent des utilisateurs ou de l'IA). */
export function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Appel à l'API FastAPI (même domaine) avec le jeton de la session Supabase. */
export async function api(chemin, { methode = "GET", json, formData } = {}) {
  const { data } = await supabase.auth.getSession();
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
    const detail = Array.isArray(contenu.detail)
      ? contenu.detail.map((d) => d.msg).join(" ; ")
      : contenu.detail || `Erreur ${r.status}`;
    const erreur = new Error(detail);
    erreur.status = r.status;
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

/** Écran de connexion (+ mot de passe oublié). Résout quand l'utilisateur est connecté. */
export function ecranConnexion(conteneur, titre) {
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
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const { error } = await supabase.auth.signInWithPassword({ email: form.email.value.trim(), password: form.mdp.value });
      if (error) $("#msg-connexion").textContent = "E-mail ou mot de passe incorrect.";
      else resoudre();
    });
    $("#mdp-oublie", conteneur).addEventListener("click", async () => {
      const email = form.email.value.trim();
      if (!email) return ($("#msg-connexion").textContent = "Saisissez d'abord votre e-mail.");
      await supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      $("#msg-connexion").classList.replace("text-red-400", "text-emerald-400");
      $("#msg-connexion").textContent = "Si un compte existe, un e-mail de réinitialisation vient d'être envoyé.";
    });
  });
}

/** Après un lien d'invitation / de réinitialisation : choix du mot de passe. */
export function ecranNouveauMotDePasse(conteneur) {
  return new Promise((resoudre) => {
    conteneur.innerHTML = `
      <div class="min-h-screen flex items-center justify-center p-6">
        <form class="w-full max-w-sm space-y-4 bg-slate-900 border border-slate-800 rounded-2xl p-6" id="form-mdp">
          <h1 class="text-xl font-bold text-center">Choisissez votre mot de passe</h1>
          <input name="mdp" type="password" required minlength="8" autocomplete="new-password" placeholder="8 caractères minimum" class="champ">
          <button class="bouton w-full">Enregistrer</button>
          <p id="msg-mdp" class="text-sm text-center text-red-400"></p>
        </form>
      </div>`;
    const form = $("#form-mdp", conteneur);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const { error } = await supabase.auth.updateUser({ password: form.mdp.value });
      if (error) $("#msg-mdp").textContent = "Mot de passe refusé (trop simple ou déjà compromis). Choisissez-en un autre.";
      else { history.replaceState(null, "", location.pathname); resoudre(); }
    });
  });
}

export async function sessionCourante() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

// Dates au format AAAA-MM-JJ en heure locale
export const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const decalerJours = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return isoLocal(d); };
export const dateLisible = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
