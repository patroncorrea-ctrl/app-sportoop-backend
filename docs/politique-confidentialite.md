# Politique de confidentialité — ADRM Sportoop

> **PROJET à faire valider** (idéalement par un juriste ou un DPO) avant publication. Les passages entre
> crochets `[…]` sont à compléter. Rédigé d'après le fonctionnement réel de l'application au 25/09/2026.
> Les sections 4 à 7 supposent faites les étapes 1, 3 et 6 de `docs/mise-en-production.md` (inscriptions publiques
> fermées, migration `20260925_securite_rls_v2.sql` exécutée, formulaire à adresse e-mail vérifiée sans feuille
> Google Sheets associée, scénario Make en « Data is confidential ») : à vérifier avant publication.

## 1. Responsable du traitement

[Raison sociale / nom], [adresse], [e-mail de contact]. Contact pour les données personnelles : [e-mail].

## 2. Données collectées

| Catégorie | Données | Source |
|---|---|---|
| Identité et contact | nom, prénom, e-mail | achat (Systeme.io), formulaire d'inscription (adresse du compte Google utilisé pour répondre) |
| Abonnement | statut (actif / en attente / résilié), date du dernier changement de statut, date du dernier événement Systeme.io, identifiant client Systeme.io | Systeme.io, coach |
| Inscription | date de réception du formulaire d'inscription | formulaire d'inscription |
| Objectifs | objectifs caloriques et de macronutriments, jours d'entraînement | formulaire, coach |
| **Données de santé** (art. 9 RGPD) | contraintes de santé déclarées | formulaire, **uniquement avec consentement explicite** |
| Suivi nutritionnel | aliments consommés, quantités, valeurs nutritionnelles, horodatage | saisie par l'utilisateur |
| Suivi sportif | séances réalisées ou manquées, ressenti, commentaires | saisie par l'utilisateur |
| Photos de repas | image de l'assiette | uniquement si l'utilisateur utilise l'estimation par photo |
| Connexion | e-mail, mot de passe (stocké chiffré par Supabase), journaux techniques | Supabase Auth |

Les données de suivi nutritionnel et sportif peuvent révéler des informations sur la santé : elles sont traitées
avec le même niveau de protection que les données de santé.

## 3. Finalités et bases légales

| Finalité | Base légale |
|---|---|
| Fournir le coaching (programme, suivi, conseils) | exécution du contrat |
| Traiter les contraintes de santé pour adapter le programme | **consentement explicite** (art. 9.2.a), retirable à tout moment |
| Gérer l'abonnement et la facturation | exécution du contrat, obligations légales |
| Sécuriser le service (authentification, prévention des abus) | intérêt légitime |

## 4. Destinataires et sous-traitants

| Sous-traitant | Rôle | Localisation |
|---|---|---|
| Supabase | base de données et authentification | Union européenne (Irlande, `eu-west-1`) |
| Railway | hébergement de l'application | Union européenne (Amsterdam) |
| Systeme.io | vente et gestion des abonnements, e-mails | [à vérifier] |
| [Fournisseur d'e-mails (SMTP), ex. Brevo] | envoi des e-mails d'invitation et de connexion (adresse e-mail uniquement) | [à compléter — de préférence UE] |
| Make.com | transfert des réponses du formulaire d'inscription vers l'application ; contenu des transferts non conservé (voir section 5) | [à vérifier] |
| Google (Forms) | formulaire d'inscription ; réponses conservées le temps de leur enregistrement dans l'application (voir section 5) | [à vérifier — transfert hors UE possible] |
| Google (Gemini) | estimation des aliments à partir d'une **photo de repas**, uniquement si l'utilisateur l'utilise | [à vérifier — transfert hors UE possible] |
| Open Food Facts | recherche d'un produit par **code-barres** (aucune donnée personnelle transmise) | France |

Photo de repas : elle est envoyée à Google uniquement pour produire l'estimation. **Elle n'est ni conservée ni
journalisée** par ADRM Sportoop. Le service utilise une offre payante de l'API Gemini, dont les conditions excluent
la réutilisation des contenus pour l'entraînement des modèles [à confirmer au moment de l'activation].

Aucune donnée n'est vendue ni utilisée à des fins publicitaires.

## 5. Durées de conservation

- Données du compte et de suivi : pendant l'abonnement, puis [3 ans] après la résiliation, puis suppression.
- Inscription restée sans achat (fiche « en attente ») : [6 mois] après le passage « en attente » (en général, la
  réception du formulaire), puis suppression.
- Contraintes de santé : jusqu'au retrait du consentement ou à la suppression du compte, dans l'application comme
  dans les copies ci-dessous.
- Réponses au formulaire d'inscription chez Google (Google Forms), qui contiennent aussi les contraintes de santé :
  [1 mois] après leur réception, le temps de les enregistrer dans l'application, puis suppression.
- Données transmises par Make : le contenu des transferts n'est pas conservé (option de confidentialité du
  scénario, exécutions en erreur non stockées) [réglage à confirmer avant publication].
- Photos de repas : aucune conservation.
- Données de facturation : 10 ans (obligation comptable), chez Systeme.io.

Ces durées ne sont **pas appliquées automatiquement** : l'application ne comporte pas de suppression programmée. Elles
sont appliquées par des **revues manuelles** du coach : chaque mois pour les réponses au formulaire chez Google ;
au moins **tous les 6 mois** pour les comptes résiliés (ou restés en attente) depuis plus longtemps que la durée
ci-dessus, datés par l'application à chaque changement de statut, qu'il supprime depuis son espace. Une donnée peut
donc être conservée jusqu'à 1 mois (réponses au formulaire) ou 6 mois (comptes) au-delà de la durée annoncée [durées
à confirmer avec le juriste / DPO].

## 6. Vos droits

Accès, rectification, effacement, limitation, portabilité, opposition, et **retrait du consentement** au
traitement de vos données de santé à tout moment, sans remettre en cause la licéité du traitement antérieur.
Pour exercer ces droits : [e-mail]. Vous pouvez aussi introduire une réclamation auprès de la CNIL (www.cnil.fr).
Les demandes sont traitées dans un délai d'un mois.

- **Effacement** : le coach supprime votre fiche depuis son espace. Cette suppression est définitive et porte sur
  l'ensemble de vos données dans l'application (profil, objectifs, contraintes de santé, journal alimentaire, séances
  et historique) **ainsi que votre compte de connexion**. Le coach supprime aussi, à la main, les copies conservées
  hors de l'application : votre réponse au formulaire d'inscription chez Google, les éventuelles traces de son
  transfert chez Make, et votre contact chez Systeme.io. Seules les données de facturation restent chez Systeme.io,
  pour la durée légale.
- **Retrait du consentement santé** : le coach efface vos contraintes de santé et la date de votre consentement dans
  l'application, ainsi que votre réponse au formulaire chez Google et les éventuelles traces de son transfert chez
  Make (qui contiennent ces contraintes), sans supprimer le reste de votre compte.
- **Accès et portabilité** : tant que votre abonnement est actif, vos données sont consultables dans l'application.
  Après une résiliation, l'accès à l'application est suspendu : une copie de vos données vous est transmise sur
  demande à l'adresse ci-dessus.
- **Rectification** : vos objectifs, votre programme et vos contraintes de santé sont modifiés par le coach, sur
  simple demande.

## 7. Sécurité

Connexions chiffrées (HTTPS) ; comptes créés uniquement sur invitation du coach ; accès aux données limité par des
règles de sécurité en base (chaque client ne voit que ses propres données, et seulement tant que son abonnement est
actif ; seul le coach voit l'ensemble) ; toutes les modifications faites par un client passent par le serveur de
l'application, qui les contrôle ; mots de passe jamais stockés en clair ; secrets techniques conservés hors du code
source ; données de santé jamais écrites dans les journaux techniques.

## 8. Mise à jour

Dernière mise à jour : [date de publication].
