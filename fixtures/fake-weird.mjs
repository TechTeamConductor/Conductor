#!/usr/bin/env node
// A CLI that runs but answers in a way no adapter recognises (sign-in state unknowable).
if (process.argv.includes('--version')) console.log('1.2.3');
else console.log('hmm, what?');
process.exit(0);
