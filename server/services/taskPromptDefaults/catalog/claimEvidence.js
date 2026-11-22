export const CLAIM_COMMENT_CLASSIFIER = `   CLAIMANT=$(jq -sr --arg me "$ME" '
     sort_by(.createdAt) as $comments
     | [range(0; ($comments | length)) as $i
        | $comments[$i] as $comment
        | select(($comment.type | ascii_downcase) != "bot" and $comment.login != $me)
        | ($comment.body | split("\\n") | map(select(test("^[[:space:]]*>") | not)) | join("\\n")) as $unquotedBody
        | select(($unquotedBody | test("(^|[[:space:][:punct:]])(taking this|i.?ll[[:space:]]+(take|work on|handle|implement|fix)[[:space:]]+this|i[[:space:]]+will[[:space:]]+(take|work on|handle|implement|fix)[[:space:]]+this|assign([[:space:]]+this)?[[:space:]]+to[[:space:]]+me|assign[[:space:]]+me|pr([[:space:]]+is)?[[:space:]]+incoming|i.?m[[:space:]]+working[[:space:]]+on[[:space:]]+this)([[:space:][:punct:]]|$)"; "i")))
        | select(([$comments[($i + 1):][]
          | select(.login == $comment.login)
          | select((.body | split("\\n") | map(select(test("^[[:space:]]*>") | not)) | join("\\n"))
            | test("(^|[[:space:][:punct:]])(withdraw|withdrawing|no[[:space:]]+longer[[:space:]]+(taking|working)|i[[:space:]]+will[[:space:]]+not|i.?m[[:space:]]+not|can.?t|cannot|won.?t)([[:space:][:punct:]]|$)"; "i"))] | length) == 0)
        | $comment.login][0] // empty
   ' "$COMMENTS_FILE")`;

// The data-only fallback only runs when no tool-free comment gate is configured,
// so a file-tool host receives it on demand (claimOnDemand.js); keep each
// variant's exact text here so the composer and the deferral match one string.
export const CLAIM_GITHUB_COMMENT_FALLBACK = `When no tool-free gate is present, use this conservative data-only fallback; it recognizes only the explicit claim forms below, ignores quoted comments, and emits only a login:
   \`\`\`bash
${CLAIM_COMMENT_CLASSIFIER}
   rm -f "$COMMENTS_FILE"
   \`\`\`
   A claim is the earliest still-active comment, in chronological order, by a human other than \`$ME\` that clearly says its author intends to do the work — for example "Taking this", "I'll work on this", "assign me", or "PR incoming" (including clear semantic equivalents when the tool-free classifier is available). A question, suggestion, review note, reaction, quoted claim by somebody else, or vague interest is NOT a claim. Ignore users whose API \`type\` is \`Bot\`. If that author later explicitly withdrew before anybody acted, their claim is no longer active; consider the next clear claimant.`;

export const CLAIM_GITLAB_COMMENT_FALLBACK = `Otherwise use the conservative data-only classifier below; it ignores quoted lines, bots and this login, and emits only the earliest explicit human claimant who has not withdrawn:
\`\`\`bash
${CLAIM_COMMENT_CLASSIFIER}
rm -f "$COMMENTS_FILE"
\`\`\``;
