export const workspacePolicy = Object.freeze({
  allowedRoots: ["workspace"],
  writeMode: "draft_only",
  denySymlinks: true,
  sandboxProfile: "unsafe_local_development",
  productionSecurityBoundary: false,
});
