# North star

_A way to provide Confluence context to an LLM, so you can identify
information, improve existing documentation, and identify incorrect or
redundant documentation._

## The invariant

```
fetch a space  →  give it to an LLM as context  →  find, improve, flag
```

Three jobs, and everything else exists to serve them:

- **Identify information:** answer a question from what a space actually says,
  and point to the page that says it.
- **Improve existing documentation:** propose a better version of a page, show
  the change side by side, and push it only when a person accepts it.
- **Identify incorrect or redundant documentation:** find pages that
  contradict each other, repeat each other, or describe something that is no
  longer true.

## Who it is for

A team that keeps its documentation in Confluence Server or Data Center and
depends on it being right. They are not looking for a new place to write. They
want the place they already have to be accurate.

## What "good" means here

- **The model sees what Confluence says.** Pages reach the LLM converted
  faithfully, macros and structure included, so an answer is about the page and
  not about a lossy copy of it.
- **Nothing excluded reaches a model.** A page or subtree in
  `.confluenceignore` never leaves the machine, on any path.
- **No page changes without a person.** An improvement is a proposal until
  someone reads the diff and accepts it.
- **A finding names its source.** An answer or a flagged contradiction cites
  the pages it came from, so a person can check it.

## What would mean this failed

- An excluded page reaches an LLM.
- A page in Confluence changes without someone having accepted the change.
- An answer or finding cannot be traced back to the pages it came from.
- The team stops trusting what it flags, because it is wrong often enough that
  checking it costs more than reading the pages.

## The scope fence

Anything that is not one of the three jobs enters through a decision record in
`docs/decisions.md`, never through a pull request that quietly grows what the
program is.
