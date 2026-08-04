module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-private-bootstrap-imports",
      severity: "error",
      from: { path: "^(packages|apps|examples|tooling)" },
      to: { path: "^(briefs|research)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(dist|coverage|node_modules)(/|$)" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ["exports"] },
  },
};
