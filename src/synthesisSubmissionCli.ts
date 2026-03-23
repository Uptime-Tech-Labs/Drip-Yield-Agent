import { loadProjectEnv } from "./loadEnv";
loadProjectEnv();

import { advanceSynthesisSubmission, describeSubmissionNextStep } from "./synthesisSubmission";

advanceSynthesisSubmission()
  .then((r) => {
    console.log(JSON.stringify(r, null, 2));
    console.log(describeSubmissionNextStep(r));
    if (r.phase !== "complete" && r.phase !== "already_published") process.exitCode = 1;
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
