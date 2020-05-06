import { Octokit } from '@octokit/rest';
import * as core from '@actions/core'

export function to_bool(value: string | number | boolean | null | undefined): boolean {
    if (value === 'true') {
        return true;
    }

    return typeof value === 'string'
        ? !!+value   // we parse string to integer first
        : !!value;
}

export interface PullRequest {
    [key: string]: any;
    number: number;
    html_url?: string;
    body?: string;
}

export async function sync_labels(octokit: Octokit, pr: PullRequest, to_remove: string[], to_add: string[]) {
    core.debug(`adding labels '${to_add}', removing labels ${to_remove}`);

    // We need to reretrieve all the labels on the PR as it is possible they have changed since this workflow
    // was triggered, otherwise we risk removing labels that have been added in the time between then and now
    const current_labels = await octokit.issues.listLabelsOnIssue({
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

    core.debug(`changings labels from '${current_labels}' to '${triage_labels}'`);

    await octokit.issues.replaceAllLabels({
        owner: pr.base.repo.owner.login,
        repo: pr.base.repo.name,
        issue_number: pr.number,
        labels: triage_labels,
    });
}