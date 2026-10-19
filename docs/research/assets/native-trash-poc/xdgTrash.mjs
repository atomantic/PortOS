// The Linux adapter moved into the server as `server/lib/nativeTrashXdg.js`
// (issue #12246). This shim keeps `linux-poc.mjs` and the study's links working
// against the production module; `linux-docker-run.sh` reproduces the repository
// layout inside the container so the relative path resolves there too.
export { trashXdg } from '../../../../server/lib/nativeTrashXdg.js';
