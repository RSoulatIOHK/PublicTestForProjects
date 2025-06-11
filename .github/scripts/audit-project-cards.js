// This script requires the following packages:
// npm install @actions/core @actions/github
const core = require('@actions/core');
const github = require('@actions/github');

async function run() {
  try {
    const token = core.getInput('token', { required: true });
    const projectId = core.getInput('project-id', { required: true });
    const owner = core.getInput('repo-owner', { required: true });
    const repo = core.getInput('repo-name', { required: true });
    const auditIssueNumber = core.getInput('audit-issue-number', { required: true });
    const requiredFields = core.getInput('required-fields', { required: true }).split(',').map(f => f.trim()).filter(f => f);

    const octokit = github.getOctokit(token);

    if (requiredFields.length === 0) {
      core.info("No required fields specified. Exiting.");
      return;
    }

    function isFieldEmpty(fieldValue) {
      if (!fieldValue) return true; // Field is not set at all
      switch (fieldValue.__typename) {
        case 'ProjectV2ItemFieldTextValue': return !fieldValue.text || fieldValue.text.trim() === '';
        case 'ProjectV2ItemFieldSingleSelectValue': return !fieldValue.name;
        case 'ProjectV2ItemFieldUserValue': return fieldValue.users.totalCount === 0;
        case 'ProjectV2ItemFieldIterationValue': return !fieldValue.title || fieldValue.title.includes("Planning");
        case 'ProjectV2ItemFieldNumberValue': return fieldValue.number === null;
        case 'ProjectV2ItemFieldDateValue': return !fieldValue.date;
        default: return false;
      }
    }

    let nonCompliantItems = [];
    let hasNextPage = true;
    let cursor = null;

    core.info(`Auditing project ${projectId} for required fields: ${requiredFields.join(', ')}`);

    let allItems = [];
    while(hasNextPage) {
      const query = `
        query($projectId: ID!, $cursor: String) {
          node(id: $projectId) {
            ... on ProjectV2 {
              items(first: 100, after: $cursor) {
                pageInfo { hasNextPage, endCursor }
                nodes {
                  id
                  content {
                    ... on Issue { id, number, title, url, state }
                    ... on PullRequest { id, number, title, url, state }
                  }
                }
              }
            }
          }
        }`;
      const result = await octokit.graphql(query, { projectId, cursor });
      allItems = allItems.concat(result.node.items.nodes);
      hasNextPage = result.node.items.pageInfo.hasNextPage;
      cursor = result.node.items.pageInfo.endCursor;
    }

    for (const item of allItems) {
      if (!item.content || item.content.__typename !== 'Issue' || item.content.state !== 'OPEN') {
        continue;
      }

      let missingFields = [];
      for (const requiredField of requiredFields) {
        const fieldValueQuery = `
          query($itemId: ID!) {
            node(id: $itemId) {
              ... on ProjectV2Item {
                fieldValueByName(name: "${requiredField}") {
                  __typename
                  ... on ProjectV2ItemFieldTextValue { text }
                  ... on ProjectV2ItemFieldSingleSelectValue { name }
                  ... on ProjectV2ItemFieldUserValue { users(first:1) { totalCount } }
                  ... on ProjectV2ItemFieldIterationValue { title }
                  ... on ProjectV2ItemFieldNumberValue { number }
                  ... on ProjectV2ItemFieldDateValue { date }
                }
              }
            }
          }`;
        const result = await octokit.graphql(fieldValueQuery, { itemId: item.id });
        const fieldValue = result.node.fieldValueByName;
        if (isFieldEmpty(fieldValue)) {
          missingFields.push(requiredField);
        }
      }

      if (missingFields.length > 0) {
        nonCompliantItems.push({
          number: item.content.number,
          title: item.content.title,
          url: item.content.url,
          missing: missingFields.join(', ')
        });
      }
    }

    const now = new Date().toUTCString();
    let reportBody = `### 🤖 Project Card Audit Report - ${now}\n\n`;

    if (nonCompliantItems.length === 0) {
      reportBody += `✅ All open issue cards are compliant! No missing required fields found for: **${requiredFields.join(', ')}**.`;
    } else {
      reportBody += `Found **${nonCompliantItems.length}** open issue card(s) with missing required fields:\n\n`;
      reportBody += '| Issue | Missing Fields |\n';
      reportBody += '|---|---|\n';
      for (const item of nonCompliantItems) {
        reportBody += `| [#${item.number} ${item.title}](${item.url}) | \`${item.missing}\` |\n`;
      }
    }
    
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: auditIssueNumber,
      body: reportBody
    });

    core.info(`Report posted to issue #${auditIssueNumber}.`);

  } catch (error) {
    core.setFailed(`Action failed with error: ${error.message}`);
  }
}

run();