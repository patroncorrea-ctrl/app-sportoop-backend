# Mise en production — ADRM Sportoop

Actions qui ne peuvent être faites que par le propriétaire (secrets, production, comptes tiers). Elles sont
listées **dans l'ordre où les faire**. Adresse publique : **https://app-sportoop-backend-production.up.railway.app**
(notée `<adresse>` ci-dessous).

## 0. État au 25/09/2026

| Élément | État |
|---|---|
| Railway (projet `happy-simplicity`, service `app-sportoop-backend`) | `main` déployé (fusion de la PR #1, commit `6140486`), domaine public généré. **Aucune variable définie** : `/` et `/app/` répondent, mais toutes les routes de données échouent (base non configurée) et les webhooks répondent 503. |
| Code de la branche `fix/audit` (corrections de l'audit) | Pas encore fusionné. Il **exige** la migration `20260925_securite_rls_v2.sql` (étape 3). |
| Supabase (projet `frhmfyvrcdzohsgdjjwr`, UE) | Migrations `schema_v2`, `durcissement_rls`, `abonnement_systemeio` appliquées. `20260925_securite_rls_v2.sql` **écrite, pas exécutée** (en attente de validation). 0 client, 1 coach. |
| Supabase Auth | Inscriptions publiques **ouvertes** (à fermer, étape 1), pas de SMTP personnalisé connu, protection des mots de passe compromis désactivée (1 alerte du Security Advisor). |
| Railway (facturation) | Compte en **période d'essai** : à convertir en formule payante (étape 2). |

## 1. Supabase Auth — AVANT toute invitation (obligatoire)

L'application fonctionne **uniquement sur invitation** par le coach : aucun écran d'inscription.

1. **Fermer les inscriptions publiques** : *Authentication → Sign In / Providers* → désactiver
   **« Allow new users to sign up »**.
   - Pourquoi : la clé publishable est publique (`web/config.js`). Inscriptions ouvertes, n'importe qui peut créer
     un compte avec l'e-mail d'un futur client avant son invitation, ou lire les contenus réservés aux abonnés.
   - Sans effet sur l'application : les invitations envoyées par l'API (clé service_role) et les liens
     « mot de passe oublié » des comptes existants continuent de fonctionner.
   - Ensuite, *Authentication → Users* : vérifier qu'il n'existe aucun compte inattendu (seul le coach aujourd'hui).
     Si l'invitation d'un client répond « Un autre compte de connexion utilise déjà cet e-mail », supprimer ce compte
     ici s'il n'est pas légitime, puis renvoyer l'invitation.
2. **Configurer un SMTP personnalisé** : *Authentication → Emails → SMTP Settings*. **Indispensable** : sans lui,
   Supabase n'envoie des e-mails qu'aux membres de l'équipe du projet. Toute invitation ou tout lien de connexion
   vers l'adresse d'un vrai client est refusé. L'espace coach affiche alors : « L'envoi de l'e-mail a été refusé par
   Supabase : configurez un serveur SMTP… ». L'envoi intégré est aussi limité à quelques e-mails par heure.
   - Fournisseur au choix, de préférence hébergé dans l'UE (ex. Brevo). Expéditeur sur un domaine vérifié
     (SPF, DKIM), nom d'expéditeur « ADRM Sportoop ».
   - Ensuite, *Authentication → Rate Limits* : ajuster la limite d'e-mails par heure si nécessaire.
   - Le fournisseur reçoit l'adresse e-mail des clients : l'ajouter aux sous-traitants de la politique de
     confidentialité.
3. **Mots de passe** : *Authentication → Sign In / Providers → Email*.
   - **Leaked password protection** (refus des mots de passe connus des fuites, HaveIBeenPwned) : à activer. Cette
     option n'existe qu'à partir du **plan Pro** de Supabase. Tant que l'organisation reste sur le plan gratuit, l'alerte
     `auth_leaked_password_protection` du Security Advisor ne peut pas être levée.
   - Disponible sur tous les plans : **longueur minimale 8** (la même que l'écran de choix du mot de passe, qui ne
     contrôle que dans le navigateur) et, de préférence, caractères obligatoires (minuscules, majuscules, chiffres).
4. **URL** : *Authentication → URL Configuration*.
   - *Site URL* = `https://app-sportoop-backend-production.up.railway.app/app/`
   - *Redirect URLs* : ajouter `https://app-sportoop-backend-production.up.railway.app/app/` et
     `https://app-sportoop-backend-production.up.railway.app/app/coach/` (liens d'invitation, de connexion et de
     réinitialisation du mot de passe). Sans elles, le lien de l'e-mail renvoie vers une mauvaise page.
5. **Modèles d'e-mails** : *Authentication → Emails* : traduire en français « Invite user » (invitation) et
   « Reset password » (utilisé aussi pour le lien de connexion envoyé par le coach).

## 2. Railway — variables et formule

**Formule** : le compte est en période d'essai (crédit et durée limités). À son terme, le service est arrêté :
passer à une **formule payante** avant l'arrivée des vrais clients (paramètres du compte Railway, rubrique
facturation / plans).

Onglet **Variables** du service `app-sportoop-backend`. Railway affiche les modifications comme « en attente » :
cliquer sur **Deploy** pour les appliquer (redéploiement automatique).

| Variable | Valeur |
|---|---|
| `SUPABASE_URL` | `https://frhmfyvrcdzohsgdjjwr.supabase.co` |
| `SUPABASE_KEY` | clé **service_role** / secrète (Supabase → Project Settings → API Keys). Secrète, jamais dans le frontend. |
| `WEBHOOK_SECRET` | secret aléatoire : `python -c "import secrets; print(secrets.token_urlsafe(32))"` |
| `SYSTEMEIO_WEBHOOK_SECRET` | secret affiché par Systeme.io à la création du webhook (étape 5) |
| `SYSTEMEIO_PRICE_PLAN_IDS` | facultatif : identifiants des offres de coaching, séparés par des virgules (étape 5) |
| `APP_URL` | `https://app-sportoop-backend-production.up.railway.app` (**sans** `/app` ni `/` final : l'API ajoute `/app/`) |
| `PHOTO_IA_ACTIVE` | `false` (voir étape 7) |

Garder **une seule instance** (*Settings → Deploy → Replicas* = 1, un seul worker uvicorn) : les limites de débit
sont comptées en mémoire, par processus (voir étape 9).

## 3. Migration SQL — AVANT de déployer le code de `fix/audit`

Fichier `supabase/migrations/20260925_securite_rls_v2.sql`, à relire puis à exécuter dans *Supabase → SQL Editor*.
Elle est additive (aucune donnée supprimée) et s'exécute en une transaction : en cas d'erreur, rien n'est appliqué.

Ce qu'elle fait :
- statut d'abonnement `EN_ATTENTE` autorisé (en plus de `ACTIF` et `RESILIE`) et colonne `formulaire_recu_le` ;
- en base aussi, seul un abonnement `ACTIF` donne accès aux données (un client résilié ou en attente ne lit plus rien,
  même en appelant directement l'API REST de Supabase) ;
- un client ne peut plus écrire directement en base : toutes ses écritures passent par l'API, qui applique les
  contrôles ;
- les boutons et règles de redirection ne sont plus lisibles par un compte sans fiche client active ;
- chaque changement de statut est daté par la base (colonne `statut_modifie_le`, heure du serveur), quelle qu'en soit
  l'origine (achat, résiliation, formulaire, coach). C'est la date utilisée par la revue de conservation (étape 10) ;
  elle s'affiche dans la fiche client (« Statut en vigueur depuis le… ») et ne peut pas être modifiée à la main.

**Ordre impératif** : migration d'abord, déploiement ensuite. Le nouveau code enregistre le statut `EN_ATTENTE` et lit
`formulaire_recu_le` (webhook du formulaire, espace coach) : sans la migration, le webhook du formulaire échoue et la
liste des clients de l'espace coach ne se charge plus. À l'inverse, le code actuellement en production fonctionne
avec la migration déjà appliquée.

Vérifications (requêtes en fin de fichier, en commentaire) : contrainte élargie, deux nouvelles colonnes, trigger
`clients_date_statut` actif, aucune policy « client » autre que `SELECT`. Puis *Advisors → Security Advisor* : seule
l'alerte des mots de passe compromis doit rester (étape 1.3).

## 4. GitHub — fusion dans `main`

Railway déploie automatiquement `main`. Ouvrir une pull request `fix/audit` → `main` et la fusionner **après les
étapes 1 à 3**.

### Vérifications après déploiement

`/` et `/app/` répondent même sans aucune variable, et `/journal` sans jeton répond toujours 401 (refus avant toute
lecture de la configuration) : ces pages ne prouvent donc **rien** sur les variables. De même, la liste des clients
de l'espace coach est lue directement dans Supabase, sans passer par le serveur Railway. Il faut des appels qui
**lisent la configuration du serveur** :

**1. Variables présentes** (aucun effet, aucune donnée). Dans PowerShell, écrire `curl.exe` (et non `curl`, qui y
désigne une autre commande) ; `-i` affiche le code de réponse.

| Commande | Réponse attendue | Sinon |
|---|---|---|
| `curl.exe -i https://<adresse>/` | 200 `{"status":"API en ligne",…}` | service arrêté : journaux Railway (*Deployments → View logs*) |
| `curl.exe -i -H "Authorization: Bearer test" https://<adresse>/journal` | 401 « Jeton d'authentification invalide. » | 503 « Base de données non configurée. » = `SUPABASE_URL` ou `SUPABASE_KEY` absente |
| `curl.exe -i -X POST https://<adresse>/webhooks/nouveau-client` | 401 « Secret webhook invalide. » | 503 « Webhook non configuré. » = `WEBHOOK_SECRET` absent |
| `curl.exe -i -X POST https://<adresse>/webhooks/systemeio` | 401 « Signature invalide. » | 503 « Webhook non configuré. » = `SYSTEMEIO_WEBHOOK_SECRET` absent (normal tant que l'étape 5 n'est pas faite) |

**2. Valeurs exactes** : une variable présente mais fausse (faute de frappe, mauvaise clé) donne les **mêmes** 401
ci-dessus. Seuls des essais de bout en bout la détectent :
- `SUPABASE_URL` / `SUPABASE_KEY` : espace coach `https://<adresse>/app/coach/` → **+ Nouveau client** (nom « Test
  déploiement », e-mail fictif, par ex. `test-deploiement@example.com`) → fiche → **Supprimer le client…**. Cette
  suppression passe par le serveur Railway avec la clé service_role (contrôle du coach, recherche du compte de
  connexion, suppression). Attendu : « Test déploiement et toutes ses données ont été supprimés. »
  - « Accès réservé au coach. » : `SUPABASE_KEY` n'est pas la clé **service_role** / secrète (clé publishable ou anon
    collée par erreur).
  - « Le service est momentanément indisponible » qui persiste : `SUPABASE_URL` ou `SUPABASE_KEY` erronée (le serveur
    ne parvient pas à vérifier la session du coach auprès de Supabase, alors que le navigateur, lui, y parvient).
  - « Base de données non configurée. » : variable absente (tableau ci-dessus).
- `WEBHOOK_SECRET` : exécution de test du scénario Make (étape 6). Réponse 401 = secret différent entre Make et Railway.
- `SYSTEMEIO_WEBHOOK_SECRET` : vente de test (étape 5). Réponse 401 dans l'historique du webhook Systeme.io = secret
  différent.
- `APP_URL` : le lien du premier e-mail d'invitation (étape 8) doit ouvrir `https://<adresse>/app/`.

## 5. Systeme.io — achats et résiliations

Automatisations → Webhooks → créer un webhook vers `https://<adresse>/webhooks/systemeio`, événements
**New sale** et **Sale canceled**. Copier le secret dans `SYSTEMEIO_WEBHOOK_SECRET` (étape 2).

- Achat (`SALE_NEW`) : fiche créée ou passée `ACTIF`. Résiliation ou remboursement (`SALE_CANCELED`) : `RESILIE`.
- Un événement plus ancien que le dernier appliqué est ignoré (livraison en retard, nouvelle tentative).
- **Filtre des offres** : sans `SYSTEMEIO_PRICE_PLAN_IDS`, **toute** vente du compte Systeme.io (ebook, order bump…)
  donne accès à l'application. Pour ne compter que le coaching, faire une vente de test, relever `pricePlan.id` dans
  le JSON envoyé (historique du webhook dans Systeme.io), puis renseigner la variable, par ex. `123456,123457`.
- **Vérification** : après la vente de test, l'historique du webhook doit montrer une réponse 200 (401 = secret
  différent de `SYSTEMEIO_WEBHOOK_SECRET`). Supprimer ensuite la fiche de test (étape 8, **Supprimer le client**).

## 6. Make — formulaire d'onboarding (Google Forms → API)

### Réglages du formulaire Google Forms (obligatoires)

*Paramètres → Réponses* :
- **« Collecter les adresses e-mail : Vérifiées »** : le répondant se connecte à Google, et l'adresse collectée est
  celle de son compte, que personne ne peut saisir à sa place. **Supprimer la question « E-mail »** du formulaire :
  c'est cette adresse vérifiée qui est envoyée à l'API (champ `email`, tableau ci-dessous). Sans cela, quiconque
  connaît l'e-mail d'un acheteur peut remplir sa fiche le premier (nom, jours, contraintes de santé, faux
  consentement), et la vraie réponse du client est ensuite refusée (409).
- **« Limiter à 1 réponse »**.
- Prévenir le client (description du formulaire, e-mail de confirmation d'achat Systeme.io) : **se connecter à Google
  avec l'adresse utilisée pour l'achat**. Une adresse autre que Gmail peut servir de compte Google (option « Utiliser
  mon adresse e-mail actuelle » à la création du compte). Avec une autre adresse, la fiche du formulaire reste
  `EN_ATTENTE` : voir « Deux fiches pour une personne » (étape 8).
- **Ne pas associer de feuille Google Sheets** (onglet *Réponses*) : le module Google Forms de Make lit directement les
  réponses. Une feuille serait une copie de plus des données de santé, que la suppression des réponses dans Google
  Forms n'efface pas. Si une feuille existe déjà, la supprimer (ou en effacer les lignes en même temps que les
  réponses, étape 10).
- Les réponses restent stockées dans Google Forms : les supprimer une fois enregistrées dans l'application (étape 10).

### Réglages du scénario Make (confidentialité)

*Scenario settings* :
- **« Data is confidential »** activé : Make ne conserve pas le contenu des exécutions (réponses du formulaire, corps
  envoyé à l'API, y compris pour les 409 et 422). Les erreurs restent signalées, sans leur contenu.
- **« Allow storing of incomplete executions »** désactivé : sinon une exécution en erreur est conservée avec ses
  données pour être rejouée.
- Notifications d'erreur du scénario activées, pour voir les 409 / 422 (tableau « Comportement et réponses »).

### Appel de l'API

Déclencheur : module **Google Forms → Watch Responses**. Puis module **HTTP → Make a request** : URL
`https://<adresse>/webhooks/nouveau-client`, méthode `POST`, corps JSON, header `X-Webhook-Secret` = valeur de
`WEBHOOK_SECRET`.

**Construire le corps avec le module « JSON → Create JSON »** (ou l'équivalent qui échappe les valeurs), et non en
écrivant le JSON à la main : un guillemet ou un retour à la ligne dans les contraintes de santé rendrait le corps
invalide (réponse 422).

### Correspondance des champs

| Champ JSON | Question du formulaire | Obligatoire | Formats acceptés |
|---|---|---|---|
| `nom` | Prénom + Nom (`{{Prénom}} {{Nom}}`) | oui | texte, 200 caractères max. ; vide → 422 |
| `email` | **aucune question** : adresse vérifiée du répondant, sortie « Respondent email » du module Google Forms (champ `respondentEmail` de l'API Google Forms ; libellé exact selon la version du module) | oui | adresse valide (mise en minuscules). **Doit être celle de l'achat Systeme.io** (le client se connecte à Google avec cette adresse). |
| `target_kcal` | *(seulement si le formulaire la pose)* | non | entier 800–6000 ; « 2 000 » ou « 2000,5 » acceptés (arrondi) ; vide = non répondu |
| `target_proteines` / `target_glucides` / `target_lipides` | *(idem)* | non | entiers 0–500 / 0–1000 / 0–500 ; mêmes formats |
| `jours_sport` | Jours disponibles (cases à cocher) | non | liste, ou texte « Lundi, Mercredi » (séparateurs `,` `;` retour à la ligne) ; noms Lundi…Dimanche, majuscules indifférentes ; vide = non répondu |
| `contraintes_sante` | Contraintes de santé | non | texte, 5000 caractères max. ; vide = rien d'enregistré |
| `consentement_sante` | Case obligatoire « J'accepte que mes données de santé soient traitées pour adapter mon programme » | **oui dès qu'il y a des contraintes de santé** | `true`, « Oui », le libellé coché (« J'accepte… ») ou la liste des libellés cochés. Vide, « Non » ou valeur non reconnue = refus |

- **Consentement obligatoire** (RGPD art. 9) : si `contraintes_sante` est rempli sans consentement reconnu, **toute la
  réponse** est refusée (422) et rien n'est enregistré. Rendre la case obligatoire dans Google Forms et mapper sa
  réponse (pas de `true` écrit en dur).
- **Ne pas envoyer d'objectifs fixes** (1830 kcal, etc.) : sans réponse, la base applique déjà ses valeurs par défaut
  (1830 / 183 / 137 / 61), et le coach les ajuste ensuite.
- Exemple de structure à produire :

```json
{
  "nom": "{{Prénom}} {{Nom}}",
  "email": "{{Respondent email}}",
  "jours_sport": "{{Jours disponibles}}",
  "contraintes_sante": "{{Contraintes de santé}}",
  "consentement_sante": "{{Consentement santé}}"
}
```

### Comportement et réponses

| Situation | Résultat |
|---|---|
| E-mail inconnu (formulaire rempli avant l'achat, ou avec un compte Google d'une autre adresse) | fiche créée **`EN_ATTENTE`** (aucun accès) — 200 `fiche_creee` |
| Fiche existante jamais complétée (créée par l'achat ou par le coach) | fiche complétée, statut inchangé — 200 `fiche_completee` |
| Formulaire déjà reçu pour cet e-mail | **409** : rien n'est modifié, seul le coach modifie la fiche ensuite |
| Secret absent ou faux / non configuré | 401 / 503 |
| Réponse invalide (voir tableau) | 422 |

Le formulaire n'est accepté qu'une fois par e-mail : ensuite, seul le coach modifie la fiche. Cette règle s'ajoute à
l'adresse vérifiée, elle ne la remplace pas : avec une question « E-mail » en texte libre, la première réponse
pourrait venir de n'importe qui.

**Vérification** (valide aussi `WEBHOOK_SECRET`, étape 4) : répondre au formulaire avec son propre compte Google, puis
lancer le scénario (*Run once*) : réponse 200 `fiche_creee` et fiche « en attente » visible dans l'espace coach
(401 = secret différent entre Make et Railway). Supprimer ensuite la fiche de test (étape 8) et la réponse de test
dans Google Forms.

## 7. Estimation par photo (facultatif)

1. Créer une clé Gemini sur un projet Google **avec facturation activée** (le niveau gratuit peut réutiliser les
   contenus envoyés).
2. Publier la politique de confidentialité (`docs/politique-confidentialite.md`, à compléter).
3. Railway : `GEMINI_API_KEY` = la clé, puis `PHOTO_IA_ACTIVE` = `true`.

## 8. Clients : statuts, invitation, suppression

| Événement | Fiche inexistante | Fiche existante |
|---|---|---|
| Achat Systeme.io | créée `ACTIF` | passe `ACTIF` (nom saisi au formulaire conservé) |
| Résiliation / remboursement | ignoré | passe `RESILIE` |
| Formulaire | créée `EN_ATTENTE` | complétée une seule fois (statut inchangé) |
| Coach « + Nouveau client » | créée `ACTIF` | — |
| Coach, fiche → statut | — | `ACTIF`, `EN_ATTENTE` ou `RESILIE` au choix |

Seul `ACTIF` donne accès à l'application (API et base). Un client `EN_ATTENTE` ou `RESILIE` peut se connecter mais
voit un écran « abonnement en attente / résilié ». Chaque changement de statut, quelle qu'en soit l'origine, est daté
par la base (« Statut en vigueur depuis le… » dans la fiche) : cette date sert à la revue de conservation (étape 10).
`abonnement_maj_le` (« Dernier événement Systeme.io appliqué ») ne date, elle, que les achats et résiliations reçus
de Systeme.io.

- **Deux fiches pour une personne** (achat avec une adresse, formulaire rempli avec un compte Google d'une autre) : la
  fiche du formulaire reste `EN_ATTENTE`. Après avoir vérifié auprès du client que les deux adresses sont bien les
  siennes, reporter ses réponses dans la fiche `ACTIF` de l'achat (**Reporter vers une autre fiche…**), puis supprimer
  la fiche en attente.
- **Premier accès** : espace coach `https://<adresse>/app/coach/` → fiche du client → **Envoyer l'invitation**.
  - Fiche sans compte : invitation Supabase ; le client choisit son mot de passe et arrive sur
    `https://<adresse>/app/` (installable sur l'écran d'accueil du téléphone).
  - Compte déjà lié (invitation expirée ou perdue, mot de passe oublié) : le même bouton envoie un **lien de
    connexion** permettant de choisir un nouveau mot de passe.
  - Erreur « l'envoi de l'e-mail a été refusé par Supabase » : SMTP absent ou limite d'envoi atteinte (étape 1.2).
  - Erreur « un autre compte de connexion utilise déjà cet e-mail » : voir étape 1.1.
- **Suppression (droit à l'effacement)** : fiche du client → **Supprimer le client**. Supprime définitivement la fiche,
  toutes ses données (journal, aliments, séances, historique, règles et boutons propres) **et son compte de
  connexion**. Irréversible. **Rien n'est effacé hors de l'application** : compléter à la main, le même jour :
  1. **Google Forms** : onglet *Réponses → Individuelle*, retrouver la réponse de la personne → icône corbeille ;
     et, si une feuille Google Sheets est associée malgré l'étape 6, supprimer sa ligne (la suppression dans Google
     Forms ne l'efface pas).
  2. **Make** : si « Data is confidential » n'était pas activé, supprimer les exécutions du scénario qui contiennent
     sa réponse (*History*, et *Incomplete executions* s'il y en a).
  3. **Systeme.io** : résilier l'abonnement s'il est encore actif ; en cas de demande d'effacement, supprimer aussi le
     contact. Les données de facturation y restent (obligation comptable, 10 ans).
- **Retrait du consentement santé seul** : fiche du client → **Effacer ces données (retrait du consentement)** (efface
  les contraintes de santé et la date du consentement), puis supprimer de même sa réponse Google Forms (et la ligne de
  la feuille, les exécutions Make), qui contiennent ces contraintes. Le reste de ses réponses est déjà dans la fiche.

## 9. Limitation de débit et tailles maximales (déjà en place dans l'API)

| Protection | Limite | Réponse |
|---|---|---|
| Estimation par photo (facturée par Gemini) | 6 par minute et 40 par jour, par client | 429 + `Retry-After` |
| Recherche de produit (Open Food Facts) | 30 par minute par client, 90 par minute pour tout le serveur | 429 + `Retry-After` |
| Taille des requêtes | 64 Ko (JSON, webhooks), 9 Mo (photo, 8 Mo d'image) | 413 |
| Routes client / coach sans jeton | refusées avant lecture du corps | 401 |

Les compteurs sont en mémoire : remis à zéro à chaque redémarrage, et multipliés par le nombre d'instances (garder
une seule instance, étape 2). Supabase Auth applique ses propres limites (connexions, e-mails : *Authentication →
Rate Limits*).

## 10. Conservation des données — revues périodiques (manuelles)

Aucune purge automatique n'existe (pas de tâche planifiée). Une suppression automatique et irréversible de fiches et
de comptes de connexion serait une opération destructive planifiée, à décider par le propriétaire ; elle effacerait
aussi, sans contrôle humain, une fiche dont la date de résiliation est discutable (voir ci-dessous). Les durées de la
politique de confidentialité (section 5) sont donc appliquées **à la main** :

### Chaque mois : réponses au formulaire (Google, Make)

1. Espace coach : vérifier que chaque réponse reçue depuis la revue précédente est enregistrée dans une fiche
   (« Formulaire d'onboarding : reçu le… ») ou a été traitée (409 / 422 signalés par Make).
2. Google Forms → *Réponses* → ⋮ → **Supprimer toutes les réponses** (ou une par une, dans *Individuelle*, pour garder
   une réponse pas encore traitée). Si une feuille Google Sheets est associée (déconseillé, étape 6), en effacer
   aussi les lignes : la suppression dans Google Forms ne les efface pas.
3. Make : rien à faire si « Data is confidential » est activé (étape 6) ; sinon, supprimer les exécutions du scénario
   de plus d'un mois (*History*, *Incomplete executions*).

### Au moins tous les 6 mois : fiches résiliées ou en attente

1. *Supabase → SQL Editor*, requête en lecture seule (remplacer `3 years` et `6 months` par les durées retenues dans
   la politique) :

   ```sql
   SELECT id, nom, email, statut_abonnement, statut_modifie_le, abonnement_maj_le, formulaire_recu_le, created_at
   FROM public.clients
   WHERE statut_abonnement <> 'ACTIF'
     AND (statut_modifie_le IS NULL
          OR (statut_abonnement = 'RESILIE'    AND statut_modifie_le < now() - interval '3 years')
          OR (statut_abonnement = 'EN_ATTENTE' AND statut_modifie_le < now() - interval '6 months'))
   ORDER BY statut_modifie_le NULLS FIRST;
   ```

   - La date de référence est `statut_modifie_le` : la date depuis laquelle la fiche est résiliée ou en attente. La
     base la pose à chaque changement de statut, quelle qu'en soit l'origine (achat, résiliation Systeme.io,
     formulaire, coach), et elle ne peut pas être modifiée à la main (migration `20260925_securite_rls_v2.sql`).
   - **Ne pas utiliser `abonnement_maj_le`** : elle ne date que les événements Systeme.io. Une fiche créée par le coach
     puis passée « résilié » par lui n'en a pas (elle ne serait jamais listée, donc jamais supprimée). Une fiche achetée
     il y a plus de 3 ans et résiliée hier par le coach porte la date de l'achat (elle serait supprimée trop tôt).
   - Les fiches **sans** `statut_modifie_le` (trigger absent ou désactivé, fiche antérieure à la migration) sortent en
     tête de liste : les examiner une par une, ne jamais les supprimer d'office.
2. Pour chaque fiche listée, **avant** toute suppression :
   - fiche résiliée : vérifier dans Systeme.io la date réelle de la résiliation, et qu'aucun abonnement n'a repris
     depuis (y compris sous une autre adresse). Un changement de statut fait par erreur par le coach date aussi la
     fiche : en cas de doute, conserver la fiche jusqu'à la revue suivante ;
   - fiche en attente : vérifier qu'aucun achat n'a été fait sous une autre adresse (« Deux fiches pour une personne »,
     étape 8).

   Puis espace coach → **Supprimer le client** (supprime aussi le compte de connexion) et, s'il en reste, les copies
   hors application (étape 8 : Google Forms, Make).
3. Noter la date de la revue et le nombre de fiches supprimées (registre des traitements).

Demande d'effacement ou retrait du consentement santé : à traiter sans attendre la revue (délai légal : un mois),
selon l'étape 8 : **Supprimer le client** ou **Effacer ces données (retrait du consentement)**, puis les copies hors
application (Google Forms, Make et, pour un effacement, le contact Systeme.io).
