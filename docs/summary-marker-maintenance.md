# Maintaining source summary markers

The source of truth is the `read` entry in [`PROMPTS` in
`servers/_summarize.ts`](../servers/_summarize.ts#L123). It asks the model to
preserve every listed marker verbatim with line numbers and not invent markers
absent from the source. Decorators and exports have separate instructions in
the same prompt; they are not the marker list.

## Reviewing a proposed change

1. Compare the proposed addition, removal, or spelling change with the current
   marker clause. Explain what source annotation it covers, why that matters to
   a reader, and what information might be lost or extra noise introduced.
   Inspect representative source examples, including an ordinary line without
   the marker, rather than assigning a meaning from the marker alone.
2. Check that the intended markers remain inside the **verbatim with line
   numbers** instruction, with no duplicates, and that the instruction against
   inventing absent markers remains intact. Consider the prompt's 500-character
   target: additional preservation requests can compete for limited space.
3. Review the related [marker reference](summary-marker-reference.md),
   [source map](summarize-marker-source-map.md), and other marker documents and
   tests for drift. Update affected inventories, examples, and assertions to
   reflect an intentional change; investigate failures instead of simply
   relaxing coverage. Include examples both with and without the proposed
   marker and check the source text and line numbers in expected summaries.
4. Run the marker tests, including
   [`summarize-markers.test.ts`](../__tests__/summarize-markers.test.ts) and
   [`read-marker-completeness.test.ts`](../__tests__/quality/read-marker-completeness.test.ts),
   along with the repository's typecheck, lint, and full test suite. The
   completeness test checks the vocabulary and provider wiring; its stubbed
   provider does not establish how a real model will respond.

The clause is model guidance, not a deterministic detector or a guarantee of
preservation. It defines no case, boundary, or comment-syntax matching rules;
fallback truncation can elide markers in the middle. For an exhaustive review,
request the complete source with `bypassSummary:true` and inspect it directly.
