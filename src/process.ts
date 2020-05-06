import * as core from '@actions/core'
import { Context } from '@actions/github/lib/context'
import { PullRequest } from './util'
import { Octokit } from '@octokit/rest';
import { SSL_OP_SSLEAY_080_CLIENT_DH_BUG } from 'constants';

export enum Todo {
    WaitingOnReview,
    WaitingOnAuthor,
    WaitingOnDescription,
    ReadyForMerge,
}

export enum CIStatus {
    Failure,
    Pending,
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
    required_checks: string[],
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
    }

    const ci_status = await get_ci_status(octo, pr, required_checks);

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

async function get_ci_status(octo: Octokit, pr: PullRequest, required_checks: string[]): Promise<CIStatus | undefined> {
    const statuses = await octo.repos.getCombinedStatusForRef({
        owner: pr.base.repo.owner.login,
        repo: pr.base.repo.name,
        ref: pr.head.sha,
    });

    var ci_status = undefined;
    const all_required = required_checks.length === 0;

    for (const status of statuses.data.statuses) {
        if (!all_required && !required_checks.includes(status.context)) {
            continue;
        }

        const state = parse_state(status.state);

        switch (state) {
            case CIStatus.Failure: {
                return state;
            }
            case CIStatus.Pending: {
                if (!ci_status || ci_status === CIStatus.Success) {
                    ci_status = state;
                }
                break;
            }
            case CIStatus.Success: {
                if (!ci_status) {
                    ci_status = state;
                }
                break;
            }
            case undefined: {
                break;
            }
        }
    }

    return ci_status;
}

function parse_state(state: string): CIStatus | undefined {
    switch (state) {
        case "failure": {
            return CIStatus.Failure;
        }
        case "pending": {
            return CIStatus.Pending;
        }
        case "success": {
            return CIStatus.Success;
        }
        default: {
            core.debug(`unknown status state ${state} encountered`);
            return undefined;
        }
    }
}