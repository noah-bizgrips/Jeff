# Upload Jeff to GitHub

## Browser method

1. Download and unzip `jeff-vercel-starter.zip` on your computer.
2. Open your private GitHub repository named `jeff`.
3. On the repository page, click **Add file** -> **Upload files**.
4. Open the unzipped `jeff-vercel-starter` folder on your computer.
5. Upload the CONTENTS of that folder to the ROOT of the GitHub repository. Do not upload the ZIP itself.
6. Confirm GitHub shows `app`, `public`, `package.json`, `next.config.ts`, `tsconfig.json`, `README.md`, and the other files at repository root.
7. Commit message: `Add Jeff Vercel starter`.
8. Commit to `main` for this initial bootstrap.

If your repo already contains a README, GitHub may ask about replacing/merging it. Use this package's README for the initial Jeff app, or keep your existing README and upload everything else.

## Correct root structure

```
jeff/
  app/
  public/
  package.json
  next.config.ts
  tsconfig.json
  next-env.d.ts
  README.md
  SECURITY.md
  .gitignore
  .env.example
```

Do not end up with:

```
jeff/
  jeff-vercel-starter/
    app/
    package.json
```

If that happens, Vercel will need a Root Directory override. Keeping the files at repository root is simpler.
