import * as core from '@actions/core'
import { Context } from '@actions/github/lib/context'
import { PullRequest } from './util'
import { Octokit } from '@octokit/rest';

export enum Todo {
    WaitingOnReview,
    WaitingOnAuthor,
    WaitingOnDescription,
    ReadyForMerge,
}

export enum CIStatus {
    Pending,
    Failure,
    Success,
}

interface Processed {
    todo?: Todo;
    ci_status?: CIStatus;
    pull_request: PullRequest;
}

export async function process_event(
    ctx: Context,
    octo: Octokit,
    requires_description: boolean,
): Promise<Processed> {
    const pr = ctx.payload.pull_request;

    if (!pr) {
        throw new Error('we should have a pull request object!');
    }

    core.debug(`${ctx.eventName} of type '${ctx.action}' received`);

    if (pr.draft === true) {
        core.info(`Ignoring draft PR`);
        return {
            todo: Todo.WaitingOnAuthor,
            pull_request: pr
        };
    }

    var todo = undefined;
    var ci_status = undefined;
    var check_reviews = true;

    switch (ctx.eventName) {
        case "pull_request_review": {
            break;
        }
        case "pull_request": {
            switch (ctx.action) {
                case "ready_for_review": {
                    todo = Todo.WaitingOnReview;
                    check_reviews = false;
                    break;
                }
            }
            break;
        }
        // Buildkite doesn't currently use the check_run APIs
        case "status": {
            const statuses = await octo.repos.getCombinedStatusForRef({
                owner: pr.base.repo.owner.login,
                repo: pr.base.repo.name,
                ref: pr.head.sha,
            });

            switch (statuses.data.state) {
                case "failure": {
                    ci_status = CIStatus.Failure;
                    break;
                }
                case "pending": {
                    ci_status = CIStatus.Pending;
                    break;
                }
                case "success": {
                    ci_status = CIStatus.Success;
                    break;
                }
                default: {
                    core.debug(`unknown status state ${statuses.data.state} encountered`);
                    break;
                }
            }
            break;
        }
        default: {
            break;
        }
    }

    if (check_reviews) {
        if (pr.requested_reviewers.length > 0) {
            core.debug(`Detected ${pr.requested_reviewers.length} pending reviewers`);
            todo = Todo.WaitingOnReview;
        } else {
            // Check the state of reviewers to determine if we are ready to be
            // merged or not
            const reviews = await octo.pulls.listReviews({
                owner: pr.base.repo.owner.login,
                repo: pr.base.repo.name,
                pull_number: pr.number,
            });

            const author_id: number = pr.user.id;

            // If any of the reviews are not APPROVED, we mark the PR as still
            // waiting on reviews
            if (reviews.data.length > 0) {
                // The set of reviews will contain ALL of the reviews, including old ones that have been supplanted
                // by newer ones, thus we have to keep track of the latest review for each unique user to determine
                // if it's actually been approved or not
                var reviewers = [];

                for (const review of reviews.data) {
                    const timestamp = Date.parse(review.submitted_at);

                    // Ignore review comments from the author
                    if (review.user.id === author_id) {
                        continue;
                    }

                    const ind = reviewers.findIndex((item) => item.reviewer === review.user.id);

                    if (ind == -1) {
                        reviewers.push({ reviewer: review.user.id, state: review.state, timestamp });
                    } else {
                        var item = reviewers[ind];
                        if (item.timestamp < timestamp) {
                            core.debug(`review ${JSON.stringify(review, null, 2)} is newer than ${JSON.stringify(item, null, 2)}, replacing`);
                            item.timestamp = timestamp;
                            item.state = review.state;
                        }
                    }
                }

                const all_approved = reviewers.every((review) => review.state == "APPROVED");

                if (all_approved) {
                    core.info(`All reviews are approved, marking PR as ready to merge`);
                    todo = Todo.ReadyForMerge;
                } else {
                    todo = Todo.WaitingOnReview;
                }
            } else {
                todo = Todo.WaitingOnReview;
            }
        }
    }

    if (todo == Todo.ReadyForMerge && requires_description) {
        if (!pr.body) {
            core.error(`The PR is ready to be merged, but it doesn't have a body, and one is required`);
            todo = Todo.WaitingOnDescription;
        }
    }

    return { todo, ci_status, pull_request: pr };
}
