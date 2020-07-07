import * as core from '@actions/core'
import { Context } from '@actions/github/lib/context'
import { Octokit } from '@octokit/rest';

export interface Config {
    waiting_for_review_labels: string[];
    ready_for_merge_labels: string[];
    waiting_for_author_labels: string[];
    requires_description: boolean;
    requires_review: boolean;
    ci_passed_labels: string[];
    required_checks: string[];
}

enum Todo {
    WaitingOnReview,
    WaitingOnAuthor,
    WaitingOnDescription,
    ReadyForMerge,
}

enum CIStatus {
    Failure,
    Pending,
    Success,
}

interface PullRequest {
    [key: string]: any;
    number: number;
    html_url?: string;
    body?: string;
}

interface TriageAction {
    todo?: Todo;
    ci_status?: CIStatus;
    pull_request: PullRequest;
}

async function on_status_event(ctx: Context, octo: Octokit, cfg: Config): Promise<PullRequest[]> {
    // Ignore statuses for contexts we don't care about
    if (cfg.required_checks.length > 0 && !cfg.required_checks.includes(ctx.payload.context)) {
        core.info(`Ignoring status event ${ctx.payload.state} for context ${ctx.payload.context}`);
        return [];
    }

    const branches = ctx.payload.branches;

    if (!branches || branches.length === 0) {
        core.info(`Ignoring status event for ${ctx.payload.context}, no branches found`);
        return [];
    }

    var pull_requests: PullRequest[] = [];

    for (const branch of branches) {
        const prs = await octo.pulls.list({
            owner: ctx.repo.owner,
            repo: ctx.repo.repo,
            state: "open",
            head: `${ctx.repo.owner}:${branch.name}`,
            sort: "updated",
            direction: "desc",
        });

        pull_requests.push(...prs.data);
    }

    return pull_requests;
}

export async function process_event(
    ctx: Context,
    octo: Octokit,
    cfg: Config,
): Promise<void> {
    var check_reviews = false;
    var pull_requests: PullRequest[] = [];
    if (ctx.eventName === "status") {
        pull_requests = await on_status_event(ctx, octo, cfg);
    } else if (ctx.payload.pull_request) {
        check_reviews = true;
        pull_requests.push(ctx.payload.pull_request);
    }

    if (pull_requests.length === 0) {
        core.info(`event ${ctx.eventName} didn't pertain to 1 or more pull requests, ignoring`);
        return;
    }

    var triage_actions: TriageAction[] = [];

    for (const pr of pull_requests) {
        if (pr.draft === true) {
            core.info(`Ignoring draft PR#${pr.number}`);
            triage_actions.push({
                todo: Todo.WaitingOnAuthor,
                pull_request: pr,
            });
            continue;
        }

        const ci_status = await get_ci_status(octo, pr, cfg.required_checks);
        core.debug(`CI status for PR#${pr.number} is ${ci_status}`);


        var todo = undefined;
        if (!check_reviews) {
            triage_actions.push({
                todo,
                ci_status,
                pull_request: pr,
            });
            continue;
        }

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
            // waiting on review
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
                // If there are no reviews and we allow merges without them, mark as ready for merge
                if (cfg.requires_review) {
                    core.debug(`There are no reviews but we require them, marking PR as waiting on review`);
                    todo = Todo.WaitingOnReview;
                } else {
                    core.debug(`There are no reviews and we don't require them, marking PR as ready for merge`);
                    todo = Todo.ReadyForMerge;
                }
            }
        }

        if (todo == Todo.ReadyForMerge && cfg.requires_description) {
            if (!pr.body) {
                core.error(`The PR is ready to be merged, but it doesn't have a body, and one is required`);
                todo = Todo.WaitingOnDescription;
            }
        }

        triage_actions.push({
            todo,
            ci_status,
            pull_request: pr,
        });
    }

    await update_labels(octo, cfg, triage_actions);
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

        core.debug(`checking state ${status.state} of ${status.context}`);

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

async function sync_pr_labels(octo: Octokit, pr: PullRequest, to_remove: string[], to_add: string[]) {
    core.debug(`PR#${pr.number} adding labels '${to_add}', removing labels ${to_remove}`);

    // We need to reretrieve all the labels on the PR as it is possible they have changed since this workflow
    // was triggered, otherwise we risk removing labels that have been added in the time between then and now
    const current_labels = await octo.issues.listLabelsOnIssue({
        owner: pr.base.repo.owner.login,
        repo: pr.base.repo.name,
        issue_number: pr.number,
    });

    const labels = current_labels.data.map((label) => label.name);

    var triage_labels: string[] = [];
    var changed = false;
    for (const label of labels) {
        if (!to_remove.includes(label)) {
            triage_labels.push(label);
        } else {
            changed = true;
        }
    }

    for (const add of to_add) {
        if (!triage_labels.includes(add)) {
            triage_labels.push(add);
            changed = true;
        }
    }

    if (!changed) {
        core.info(`No labels to change`);
        return;
    }

    core.debug(`changings labels from '${labels}' to '${triage_labels}'`);

    await octo.issues.replaceAllLabels({
        owner: pr.base.repo.owner.login,
        repo: pr.base.repo.name,
        issue_number: pr.number,
        labels: triage_labels,
    });
}

async function update_labels(octo: Octokit, cfg: Config, triage_actions: TriageAction[]): Promise<void> {
    for (const ta of triage_actions) {
        var to_remove: string[];
        var to_add: string[];

        switch (ta.todo) {
            case Todo.ReadyForMerge: {
                to_remove = cfg.waiting_for_review_labels.concat(cfg.waiting_for_author_labels);
                to_add = cfg.ready_for_merge_labels;
                break;
            }
            case Todo.WaitingOnReview: {
                to_remove = cfg.ready_for_merge_labels.concat(cfg.waiting_for_author_labels);
                to_add = cfg.waiting_for_review_labels;
                break;
            }
            case Todo.WaitingOnAuthor:
            case Todo.WaitingOnDescription: {
                to_remove = cfg.ready_for_merge_labels.concat(cfg.waiting_for_review_labels);
                to_add = cfg.waiting_for_author_labels;
                break;
            }
            default: {
                to_remove = [];
                to_add = [];
                break;
            }
        }

        switch (ta.ci_status) {
            case CIStatus.Success: {
                to_add.push(...cfg.ci_passed_labels);
                break;
            }
            case CIStatus.Pending:
            case CIStatus.Failure:
            default: {
                to_remove.push(...cfg.ci_passed_labels);
                break;
            }
        }

        await sync_pr_labels(octo, ta.pull_request, to_remove, to_add);
    }
}
