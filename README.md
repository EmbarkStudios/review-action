# review-action

[![Contributor Covenant](https://img.shields.io/badge/contributor%20covenant-v1.4%20adopted-ff69b4.svg)](CODE_OF_CONDUCT.md)
[![Embark](https://img.shields.io/badge/embark-open%20source-blueviolet.svg)](https://embark.dev)

Github Action that adds and removes labels based on PR review state

## Usage

```yaml
name: PR reviewer
on:
  pull_request:
    types:
      - synchronize
      - opened
      - edited
      - ready_for_review
      - reopened
      - unlocked
      - review_request_removed
      - review_requested
  pull_request_review:
    types:
      - submitted
      - dismissed
      - edited

jobs:
  review_triage:
    runs-on: [ubuntu-latest]
    steps:
      - uses: "EmbarkStudios/review-bot@v1"
        with:
          # Token to use for interacting with Github
          GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}"
          # Label(s) added to the PR when it doesn't have an approved review
          # from every reviewer, or there are no reviewers
          waitingForReview: "s: waiting on review ⏸️"
          # Label added to the PR when every review user has approved it
          readyForMerge: "automerge"
          # If true, a description is required in the PR before it can move
          # in to the readyForMerge state
          requireDescription: "true"
          # Label added when requireDescription is true, the PR doesn't have
          # a description, but all reviewers have approved it
          waitingForAuthor: "s: waiting for author ⏸️"
```

## Contributing

We welcome community contributions to this project.

Please read our [Contributor Guide](CONTRIBUTING.md) for more information on how to get started.

## License

Licensed under either of

* Apache License, Version 2.0, ([LICENSE-APACHE](LICENSE-APACHE) or http://www.apache.org/licenses/LICENSE-2.0)
* MIT license ([LICENSE-MIT](LICENSE-MIT) or http://opensource.org/licenses/MIT)

at your option.

### Contribution

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in the work by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without any additional terms or conditions.
