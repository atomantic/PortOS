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
