import * as core from '@actions/core'
import * as github from '@actions/github'
import { process_event, Config } from './process'
import { Octokit } from '@octokit/rest';

function to_bool(value: string | number | boolean | null | undefined): boolean {
    if (value === 'true') {
        return true;
    }

    return typeof value === 'string'
        ? !!+value   // we parse string to integer first
        : !!value;
}

async function run(): Promise<void> {
    try {
        // Get the JSON webhook payload for the event that triggered the workflow
        const ctx = github.context;

        const cfg = {
            waiting_for_review_labels: core.getInput('waitingForReview').split(','),
            ready_for_merge_labels: core.getInput('readyForMerge').split(','),
            waiting_for_author_labels: core.getInput('waitingForAuthor').split(','),
            requires_description: to_bool(core.getInput('requireDescription')),
            allow_merge_without_review: to_bool(core.getInput('allowMergeWithoutReview')),
            ci_passed_labels: core.getInput('ciPassed').split(','),
            required_checks: core.getInput('requiredChecks').split(','),
        };

        const token = core.getInput("GITHUB_TOKEN");

        const octokit = new Octokit({
            auth: `token ${token}`,
            userAgent: "pr-label action"
        });

        await process_event(ctx, octokit, cfg);
    } catch (error) {
        core.setFailed(error.message)
    }
}

run()
