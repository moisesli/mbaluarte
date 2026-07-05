# Notas del proyecto

## Flujo de trabajo

- **Fork → padre (upstream)**: este repo (`darwinva97/fortaleza-td`) es fork de
  `EijunnN/fortaleza-td`. Siempre que hagas un nuevo cambio de producto, debes
  emitir/actualizar un PR al padre con él. El PR vive en
  https://github.com/EijunnN/fortaleza-td/pull/1 (head `darwinva97:main` → base
  `main`). Tras push a `main` del fork, actualiza título y descripción del PR
  para reflejar el cambio concreto.

- **CI/CD**: el workflow `.github/workflows/deploy.yml` sincroniza el fork con
  el padre cada 15 min (merge `upstream/main`), compila el cliente y despliega el
  Worker a Cloudflare al final (dominio `fortaleza-td.bezenti.com`). El deploy
  ocurre en push a `main`, manual o cuando arriba llegó algo nuevo del padre.

## Verificación

- Typecheck: `npx tsc -b packages/shared apps/server apps/client apps/worker`
- Build cliente: `apps/client/node_modules/.bin/vite build` (desde `apps/client`)
- No usar `pnpm` directo en este entorno: la verificación de builds script falla
  por `ERR_PNPM_IGNORED_BUILDS`. Usa los binarios de `node_modules/.bin` y `npx`.