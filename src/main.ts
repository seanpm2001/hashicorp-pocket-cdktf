import { Construct } from 'constructs';
import {
  App,
  DataTerraformRemoteState,
  RemoteBackend,
  TerraformStack,
} from 'cdktf';
import {
  AwsProvider,
  DataAwsRegion,
} from '@cdktf/provider-aws';
import {
  ApplicationRDSCluster,
  PocketALBApplication,
  PocketPagerDuty,
} from '@pocket-tools/terraform-modules';
import { NullProvider } from '@cdktf/provider-null';
import { PagerdutyProvider } from '@cdktf/provider-pagerduty';
import { config } from './config';
import { createUnleashRDS } from './database';

class HashicorpPocketCdktf extends TerraformStack {
  constructor(scope: Construct, name: string) {
    super(scope, name);

    new AwsProvider(this, 'aws', { region: 'us-west-2' });
    new NullProvider(this, 'null_provider');

    new RemoteBackend(this, {
      hostname: 'app.terraform.io',
      organization: 'Pocket',
      workspaces: [{ prefix: 'HashicorpPocketCdktf-' }],
    });

    new PagerdutyProvider(this, 'pagerduty_provider', {
      token: undefined,
    });

    const rds = createUnleashRDS(this);

    this.createPocketAlbApplication(rds);
  }

  private createPocketAlbApplication(rds: ApplicationRDSCluster): PocketALBApplication {
    const region = new DataAwsRegion(this, 'region');
    const pagerDuty = this.createPagerDuty();

    return new PocketALBApplication(this, 'application', {
      region: region.name,
      internal: false,
      prefix: config.prefix,
      alb6CharacterPrefix: config.shortName,
      tags: config.tags,
      cdn: false,
      domain: config.domain,
      vpcConfig: config.vpcConfig,

      containerConfigs: [
        {
          name: 'app',
          containerImage: 'unleashorg/unleash-server:4.1.4',
          portMappings: [
            {
              hostPort: config.unleashPort,
              containerPort: config.unleashPort,
            },
          ],
          envVars: [
            {
              name: 'HTTP_PORT',
              value: `${config.unleashPort}`,
            },
          ],
          secretEnvVars: [
            {
              name: 'DATABASE_HOST',
              valueFrom: `${rds.secretARN}:host::`,
            },
            {
              name: 'CONTENT_DATABASE_PORT',
              valueFrom: `${rds.secretARN}:port::`,
            },
            {
              name: 'DATABASE_USERNAME',
              valueFrom: `${rds.secretARN}:username::`,
            },
            {
              name: 'DATABASE_PASSWORD',
              valueFrom: `${rds.secretARN}:password::`,
            },
            {
              name: 'DATABASE_NAME',
              valueFrom: `${rds.secretARN}:dbname::`,
            },
          ],
        },
      ],

      exposedContainer: {
        name: 'app',
        port: config.unleashPort,
        healthCheckPath: '/',
      },

      ecsIamConfig: {
        prefix: config.prefix,
        taskExecutionRolePolicyStatements: [
          {
            actions: ['secretsmanager:GetSecretValue', 'kms:Decrypt'],
            resources: [`${rds.secretARN}`],
            effect: 'Allow',
          },
        ],
        taskRolePolicyStatements: [],
        taskExecutionDefaultAttachmentArn:
          'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
      },

      autoscalingConfig: {
        targetMinCapacity: 1,
        targetMaxCapacity: 2,
      },

      alarms: {
        http5xxErrorPercentage: {
          threshold: 10,
          evaluationPeriods: 2,
          period: 600,
          actions:
            config.environment === 'Dev'
              ? []
              : [pagerDuty.snsNonCriticalAlarmTopic.arn],
        },
        httpLatency: {
          evaluationPeriods: 2,
          threshold: 500,
          actions:
            config.environment === 'Dev'
              ? []
              : [pagerDuty.snsNonCriticalAlarmTopic.arn],
        },
      },

      codeDeploy: {
        useCodeDeploy: false,
      },
    });
  }

  private createPagerDuty() {
    // To effectively manage escalation policies, you can create an
    // incident management service that outputs Pagerduty
    // escalation policy IDs that can be used directly
    // with the PocketPagerDuty construct below.
    // const incidentManagement = new DataTerraformRemoteState(
    //   this,
    //   'incident_management',
    //   {
    //     organization: 'Pocket',
    //     workspaces: {
    //       name: 'incident-management',
    //     },
    //   }
    // );
    //
    // Example of getting an output from the service:
    // `incidentManagement.get('policy_backend_critical_id')`

    return new PocketPagerDuty(this, 'pagerduty', {
      prefix: config.prefix,
      service: {
        criticalEscalationPolicyId: config.pagerDutyEscalationPolicy,
        nonCriticalEscalationPolicyId: config.pagerDutyEscalationPolicy,
      },
    });
  }
}

const app = new App();
new HashicorpPocketCdktf(app, 'pocket-cdktf');
app.synth();
