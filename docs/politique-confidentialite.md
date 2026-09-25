# Politique de confidentialité — ADRM Sportoop

> **PROJET à faire valider** (idéalement par un juriste ou un DPO) avant publication. Les passages entre
> crochets `[…]` sont à compléter. Rédigé d'après le fonctionnement réel de l'application au 25/09/2026.

## 1. Responsable du traitement

[Raison sociale / nom], [adresse], [e-mail de contact]. Contact pour les données personnelles : [e-mail].

## 2. Données collectées

| Catégorie | Données | Source |
|---|---|---|
| Identité et contact | nom, prénom, e-mail | achat (Systeme.io), formulaire d'inscription |
| Abonnement | statut (actif / résilié), date de mise à jour, identifiant client Systeme.io | Systeme.io |
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
| Make.com | transfert des réponses du formulaire d'inscription | [à vérifier] |
| Google (Forms) | formulaire d'inscription | [à vérifier — transfert hors UE possible] |
| Google (Gemini) | estimation des aliments à partir d'une **photo de repas**, uniquement si l'utilisateur l'utilise | [à vérifier — transfert hors UE possible] |
| Open Food Facts | recherche d'un produit par **code-barres** (aucune donnée personnelle transmise) | France |

Photo de repas : elle est envoyée à Google uniquement pour produire l'estimation. **Elle n'est ni conservée ni
journalisée** par ADRM Sportoop. Le service utilise une offre payante de l'API Gemini, dont les conditions excluent
la réutilisation des contenus pour l'entraînement des modèles [à confirmer au moment de l'activation].

Aucune donnée n'est vendue ni utilisée à des fins publicitaires.

## 5. Durées de conservation

- Données du compte et de suivi : pendant l'abonnement, puis [3 ans] après la résiliation, puis suppression.
- Contraintes de santé : jusqu'au retrait du consentement ou à la suppression du compte.
- Photos de repas : aucune conservation.
- Données de facturation : 10 ans (obligation comptable), chez Systeme.io.

## 6. Vos droits

Accès, rectification, effacement, limitation, portabilité, opposition, et **retrait du consentement** au
traitement de vos données de santé à tout moment, sans remettre en cause la licéité du traitement antérieur.
Pour exercer ces droits : [e-mail]. Vous pouvez aussi introduire une réclamation auprès de la CNIL (www.cnil.fr).

## 7. Sécurité

Connexions chiffrées (HTTPS) ; accès aux données limité par des règles de sécurité en base (chaque client ne voit
que ses propres données, seul le coach voit l'ensemble) ; mots de passe jamais stockés en clair ; secrets techniques
conservés hors du code source ; données de santé jamais écrites dans les journaux techniques.

## 8. Mise à jour

Dernière mise à jour : [date de publication].
