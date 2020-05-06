import * as core from '@actions/core'
import * as github from '@actions/github'
import { process_event, Todo, CIStatus } from './process'
import { to_bool, sync_labels } from './util'
import { Octokit } from '@octokit/rest';

async function run(): Promise<void> {
    try {
        // Get the JSON webhook payload for the event that triggered the workflow
        const ctx = github.context;

        const waiting_for_review_labels: string[] = core.getInput('waitingForReview').split(',');
        const ready_for_merge_labels: string[] = core.getInput('readyForMerge').split(',');
        const waiting_for_author_labels: string[] = core.getInput('waitingForAuthor').split(',');
        const requires_description: boolean = to_bool(core.getInput('requireDescription'));
        const ci_passed_labels: string[] = core.getInput('ciPassed').split(',');
        const required_checks: string[] = core.getInput('requiredChecks').split(',');

        const token = core.getInput("GITHUB_TOKEN");

        const octokit = new Octokit({
            auth: `token ${token}`,
            userAgent: "pr-label action"
        });

        const processed = await process_event(ctx, octokit, requires_description, required_checks);

        var to_remove: string[];
        var to_add: string[];
        switch (processed.todo) {
            case Todo.ReadyForMerge: {
                to_remove = waiting_for_review_labels.concat(waiting_for_author_labels);
                to_add = ready_for_merge_labels;
                break;
            }
            case Todo.WaitingOnReview: {
                to_remove = ready_for_merge_labels.concat(waiting_for_author_labels);
                to_add = waiting_for_review_labels;
                break;
            }
            case Todo.WaitingOnAuthor:
            case Todo.WaitingOnDescription: {
                to_remove = ready_for_merge_labels.concat(waiting_for_review_labels);
                to_add = waiting_for_author_labels;
                break;
            }
            default: {
                to_remove = [];
                to_add = [];
                break;
            }
        }

        switch (processed.ci_status) {
            case CIStatus.Success: {
                to_add.concat(ci_passed_labels);
                break;
            }
            case CIStatus.Pending:
            case CIStatus.Failure:
            default: {
                to_remove.concat(ci_passed_labels);
                break;
            }
        }

        await sync_labels(octokit, processed.pull_request, to_remove, to_add);

        if (processed.todo == Todo.WaitingOnDescription) {
            throw new Error();
        }
    } catch (error) {
        core.setFailed(error.message)
    }
}

run()
