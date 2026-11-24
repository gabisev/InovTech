# InovTech Gestion

Espace privé de gestion des clients, factures et paiements. Il s’agit d’un service distinct du site vitrine et il nécessite Node.js 20+ ainsi qu’une base PostgreSQL persistante.

## Fonctions incluses

- Connexion privée; aucun formulaire d’inscription public.
- Comptes administrateur et membre; l’administrateur crée, désactive et réactive les comptes d’équipe.
- Fichier client partagé par l’équipe.
- Factures en brouillon puis émises avec numéro séquentiel, date d’échéance et lignes de prestation.
- Paiements partiels immuables, solde calculé et état en retard.
- USD et CDF séparés; pas de conversion ni de taux de change implicite.
- Impression d’une facture émise ou enregistrement en PDF depuis la boîte de dialogue d’impression du navigateur.

Les paiements enregistrés dans l’application sont un suivi comptable manuel : l’application ne traite pas de transferts bancaires ou Mobile Money. Les taxes, mentions légales et conditions de paiement doivent être vérifiées et ajoutées aux notes selon les besoins de l’entreprise.

## Développement local

1. Installer PostgreSQL et créer une base `inovtech_gestion`.
2. Depuis le dossier `gestion`, copier `.env.example` vers `.env`, puis définir `DATABASE_URL` et `SESSION_SECRET` (au moins 32 caractères aléatoires). Ne jamais ajouter `.env` à Git.
3. Installer les dépendances avec `npm install`.
4. Créer le premier compte administrateur avec `npm run create-admin`.
5. Démarrer avec `npm start`, puis ouvrir `http://localhost:3000`.

Le serveur initialise les tables à son démarrage. Les commandes d’administration doivent utiliser la même base que le serveur.

## Déploiement Render

L’application doit être créée comme **Web Service Node**, et non comme Static Site :

- **Repository** : `gabisev/InovTech`
- **Branch** : `master`
- **Root Directory** : `gestion`
- **Build Command** : `npm ci`
- **Start Command** : `npm start`
- **Variables** : `DATABASE_URL` (URL interne de la base PostgreSQL Render), `DATABASE_SSL=false`, `SESSION_SECRET` (secret aléatoire d’au moins 32 caractères), `NODE_ENV=production`

Créer d’abord la base PostgreSQL et le Web Service dans Render, puis exécuter `npm run create-admin` avec le `DATABASE_URL` de production pour créer le premier compte. Ne publier aucune clé, aucun mot de passe ni fichier `.env` dans Git. Le site vitrine existant demeure un Static Site séparé.

## Tests

`npm test` exécute les tests unitaires de validation des montants, quantités et dates. Pour les montants CDF, l’application accepte des nombres entiers; USD accepte jusqu’à deux décimales.
