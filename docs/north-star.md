# North star

Confluence Explorer gives a language model the contents of a Confluence space, so that a team can
use the model to work with its own documentation. It exists to do three things well:

1. **Answer questions** from what the space actually says, and show which page the answer came
   from.
2. **Propose improvements** to an existing page, show the change side by side, and publish it only
   after a person approves it.
3. **Find problems:** pages that contradict each other, repeat each other, or describe something
   that is no longer true.

Every feature in the app should serve at least one of these three jobs. A proposed feature that
serves none of them needs a recorded decision before it is built (see "The scope fence" below).

The whole app follows one path:

```
fetch a space  →  give it to a language model as context  →  answer, improve, flag
```

## Who it is for

It is for a team that keeps its documentation in Confluence Server or Data Center and depends on
that documentation being right. They are not looking for a new place to write. They want the place
they already use to be accurate.

## What "good" means here

- **The model sees what Confluence says.** Pages are converted faithfully, including their macros
  and structure, before they reach the model. An answer should be about the page itself, not about a
  copy that lost part of it in conversion.
- **Nothing excluded reaches a model.** A page or subtree listed in a space's `.confluenceignore`
  file never leaves the machine, whichever feature is being used.
- **No page changes without a person.** An improvement stays a proposal until someone has read the
  change and accepted it.
- **Every finding names its source.** An answer or a flagged contradiction cites the pages it came
  from, so that a person can check it for themselves.

## What would mean this has failed

Any of these would mean the project is not doing its job:

- An excluded page reaches a language model.
- A page in Confluence changes without someone having accepted the change.
- An answer or finding cannot be traced back to the pages it came from.
- The team stops trusting what the app flags, because it is wrong often enough that checking its
  findings takes longer than reading the pages.

## The scope fence

Anything that is not one of the three jobs enters the project through a decision record in
`docs/decisions.md`, where the reason for adding it is written down and can be challenged. It must
never arrive through a pull request that quietly widens what the program does.
