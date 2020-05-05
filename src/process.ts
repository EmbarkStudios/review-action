import * as core from '@actions/core'
import { Context } from '@actions/github/lib/context'
import { PullRequest } from './util'
import { Octokit } from '@octokit/rest';

export enum Todo {
    WaitingOnReview,
    WaitingOnAuthor,
    ReadyForMerge,
}

interface Processed {
    todo: Todo;
    pull_request: PullRequest;
}

export async function process_event(ctx: Context, octo: Octokit, requires_description: boolean): Promise<Processed> {
    const pr = ctx.payload.pull_request;

    if (pr == null) {
        throw new Error('we should have a pull request object!');
    }

    var todo = null;

    core.debug(`${ctx.eventName} of type '${ctx.action}' received`);

    switch (ctx.eventName) {
        case "pull_request_review": {
            break;
        }
        case "pull_request": {
            switch (ctx.action) {
                case "ready_for_review": {
                    todo = Todo.WaitingOnReview;
                    break;
                }
            }
            break;
        }
        default: {
            break;
        }
    }

    if (!todo) {
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

            core.debug(`PR author id is ${author_id}`);

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
                        core.debug(`Skipping ${review.state} of PR author`);
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
            todo = Todo.WaitingOnAuthor;
        }
    }

    return { todo, pull_request: pr };
}
