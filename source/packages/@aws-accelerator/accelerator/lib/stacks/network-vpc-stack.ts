/**
 *  Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import {
  DeleteDefaultVpc,
  NatGateway,
  ResourceShare,
  ResourceShareItem,
  ResourceShareOwner,
  RouteTable,
  Subnet,
  TransitGatewayAttachment,
  Vpc,
} from '@aws-accelerator/constructs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { pascalCase } from 'change-case';
import { Construct } from 'constructs';
import { AcceleratorStack, AcceleratorStackProps } from './accelerator-stack';

export class NetworkVpcStack extends AcceleratorStack {
  constructor(scope: Construct, id: string, props: AcceleratorStackProps) {
    super(scope, id, props);

    new ssm.StringParameter(this, 'SsmParamStackId', {
      parameterName: `/accelerator/${cdk.Stack.of(this).stackName}/stack-id`,
      stringValue: cdk.Stack.of(this).stackId,
    });

    //
    // Delete Default VPCs
    //
    if (props.networkConfig.defaultVpc?.delete) {
      console.log('Add DeleteDefaultVpc');
      new DeleteDefaultVpc(this, 'DeleteDefaultVpc');
    }

    // Build map of Transit Gateways. We need to know the transit gateway ids so
    // we can create attachments against them. Transit gateways that were
    // generated outside this account should have been shared during the
    // previous stack phase
    const transitGatewayIds = new Map<string, string>();

    // Keep track of all the external accounts that will need to be able to list
    // the generated transit gateway attachments
    const transitGatewayAccountIds: string[] = [];
    for (const vpcItem of props.networkConfig.vpcs ?? []) {
      const accountId = props.accountIds[props.accountsConfig.getEmail(vpcItem.account)];
      // Only care about VPCs to be created in the current account and region
      if (accountId === cdk.Stack.of(this).account && vpcItem.region == cdk.Stack.of(this).region) {
        for (const attachment of vpcItem.transitGatewayAttachments ?? []) {
          console.log(`Evaluating Transit Gateway key ${attachment.transitGateway.name}`);

          // Keep looking if already entered
          if (transitGatewayIds.has(attachment.transitGateway.name)) {
            console.log(`Transit Gateway ${attachment.transitGateway.name} already in dictionary`);
            continue;
          }

          console.log(`Transit Gateway key ${attachment.transitGateway.name} is not in map, add resources to look up`);
          const owningAccountId = props.accountIds[props.accountsConfig.getEmail(attachment.transitGateway.account)];

          // If owning account is this account, transit gateway id can be
          // retrieved from ssm parameter store
          if (owningAccountId === cdk.Stack.of(this).account) {
            const transitGatewayId = ssm.StringParameter.valueForStringParameter(
              this,
              `/accelerator/network/transitGateways/${attachment.transitGateway.name}/id`,
            );

            console.log(`Adding [${attachment.transitGateway.name}]: ${transitGatewayId} to transitGatewayIds Map`);
            transitGatewayIds.set(attachment.transitGateway.name, transitGatewayId);
          }
          // Else, need to get the transit gateway from the resource shares
          else {
            // Add to transitGatewayAccountIds list so we can create a cross
            // account access role to list the created attachments
            if (transitGatewayAccountIds.indexOf(owningAccountId) == -1) {
              transitGatewayAccountIds.push(owningAccountId);
            }

            // Get the resource share related to the transit gateway
            const resourceShare = ResourceShare.fromLookup(
              this,
              pascalCase(`${attachment.transitGateway.name}TransitGatewayShare`),
              {
                resourceShareOwner: ResourceShareOwner.OTHER_ACCOUNTS,
                resourceShareName: pascalCase(`${attachment.transitGateway.name}TransitGatewayShare`),
                owningAccountId,
              },
            );
            console.log(resourceShare.resourceShareId);

            // Represents the transit gateway resource
            const tgw = ResourceShareItem.fromLookup(
              this,
              pascalCase(`${attachment.transitGateway.name}TransitGateway`),
              {
                resourceShare,
                resourceShareItemType: 'ec2:TransitGateway',
              },
            );

            console.log(
              `Adding [${attachment.transitGateway.name}]: ${tgw.resourceShareItemId} to transitGatewayIds Map`,
            );
            transitGatewayIds.set(attachment.transitGateway.name, tgw.resourceShareItemId);
          }
        }
      }
    }

    // Create cross account access role to read transit gateway attachments if
    // there are other accounts in the list
    if (transitGatewayAccountIds.length > 0) {
      console.log(`Create IAM Cross Account Access Role`);

      const principals: iam.PrincipalBase[] = [];
      transitGatewayAccountIds.forEach(accountId => {
        principals.push(new iam.AccountPrincipal(accountId));
      });
      new iam.Role(this, 'DescribeTransitGatewaysAttachmentsRole', {
        roleName: 'AWSAccelerator-DescribeTransitGatewayAttachmentsRole',
        assumedBy: new iam.CompositePrincipal(...principals),
        inlinePolicies: {
          default: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['ec2:DescribeTransitGatewayAttachments'],
                resources: ['*'],
              }),
            ],
          }),
        },
      });
    }

    //
    // Evaluate VPC entries
    //
    for (const vpcItem of props.networkConfig.vpcs ?? []) {
      const accountId = props.accountIds[props.accountsConfig.getEmail(vpcItem.account)];
      if (accountId === cdk.Stack.of(this).account && vpcItem.region == cdk.Stack.of(this).region) {
        console.log(`Adding VPC ${vpcItem.name}`);

        //
        // Create the VPC
        //
        const vpc = new Vpc(this, pascalCase(`${vpcItem.name}Vpc`), {
          name: vpcItem.name,
          ipv4CidrBlock: vpcItem.cidrs[0],
          internetGateway: vpcItem.internetGateway,
          enableDnsHostnames: vpcItem.enableDnsHostnames ?? false,
          enableDnsSupport: vpcItem.enableDnsSupport ?? true,
          instanceTenancy: vpcItem.instanceTenancy ?? 'default',
        });
        new ssm.StringParameter(this, pascalCase(`SsmParam${pascalCase(vpcItem.name)}VpcId`), {
          parameterName: `/accelerator/network/vpc/${vpcItem.name}/id`,
          stringValue: vpc.vpcId,
        });

        // TODO: DHCP OptionSets

        // TODO: VPC FlowLogs

        //
        // Create Route Tables
        //
        const routeTableMap = new Map<string, RouteTable>();
        for (const routeTableItem of vpcItem.routeTables ?? []) {
          const routeTable = new RouteTable(
            this,
            pascalCase(`${vpcItem.name}Vpc`) + pascalCase(`${routeTableItem.name}RouteTable`),
            {
              name: routeTableItem.name,
              vpc,
            },
          );
          routeTableMap.set(routeTableItem.name, routeTable);
          new ssm.StringParameter(
            this,
            pascalCase(`SsmParam${pascalCase(vpcItem.name) + pascalCase(routeTableItem.name)}RouteTableId`),
            {
              parameterName: `/accelerator/network/vpc/${vpcItem.name}/routeTable/${routeTableItem.name}/id`,
              stringValue: routeTable.routeTableId,
            },
          );
        }

        //
        // TODO: Create NACLs
        //

        //
        // Create Subnets
        //
        const subnetMap = new Map<string, Subnet>();
        for (const subnetItem of vpcItem.subnets ?? []) {
          console.log(`Adding subnet ${subnetItem.name}`);

          const routeTable = routeTableMap.get(subnetItem.routeTable);
          if (routeTable === undefined) {
            throw new Error(`Route table ${subnetItem.routeTable} not defined`);
          }

          const subnet = new Subnet(this, pascalCase(`${vpcItem.name}Vpc`) + pascalCase(`${subnetItem.name}Subnet`), {
            name: subnetItem.name,
            availabilityZone: `${cdk.Stack.of(this).region}${subnetItem.availabilityZone}`,
            ipv4CidrBlock: subnetItem.ipv4CidrBlock,
            mapPublicIpOnLaunch: subnetItem.mapPublicIpOnLaunch,
            routeTable,
            vpc,
          });
          subnetMap.set(subnetItem.name, subnet);
          new ssm.StringParameter(
            this,
            pascalCase(`SsmParam${pascalCase(vpcItem.name) + pascalCase(subnetItem.name)}SubnetId`),
            {
              parameterName: `/accelerator/network/vpc/${vpcItem.name}/subnet/${subnetItem.name}/id`,
              stringValue: subnet.subnetId,
            },
          );
        }

        //
        // Create NAT Gateways
        //
        const natGatewayMap = new Map<string, NatGateway>();
        for (const natGatewayItem of vpcItem.natGateways ?? []) {
          console.log(`Adding NAT Gateway ${natGatewayItem.name}`);

          const subnet = subnetMap.get(natGatewayItem.subnet);
          if (subnet === undefined) {
            throw new Error(`Subnet ${natGatewayItem.subnet} not defined`);
          }

          const natGateway = new NatGateway(
            this,
            pascalCase(`${vpcItem.name}Vpc`) + pascalCase(`${natGatewayItem.name}NatGateway`),
            {
              name: natGatewayItem.name,
              subnet,
            },
          );
          natGatewayMap.set(natGatewayItem.name, natGateway);
          new ssm.StringParameter(
            this,
            pascalCase(`SsmParam${pascalCase(vpcItem.name) + pascalCase(natGatewayItem.name)}NatGatewayId`),
            {
              parameterName: `/accelerator/network/vpc/${vpcItem.name}/natGateway/${natGatewayItem.name}/id`,
              stringValue: natGateway.natGatewayId,
            },
          );
        }

        //
        // Create Transit Gateway Attachments
        //
        const transitGatewayAttachments = new Map<string, TransitGatewayAttachment>();
        for (const tgwAttachmentItem of vpcItem.transitGatewayAttachments ?? []) {
          console.log(`Adding Transit Gateway Attachment for ${tgwAttachmentItem.transitGateway.name}`);

          const transitGatewayId = transitGatewayIds.get(tgwAttachmentItem.transitGateway.name);
          if (transitGatewayId === undefined) {
            throw new Error(`Transit Gateway ${tgwAttachmentItem.transitGateway.name} not found`);
          }

          const subnetIds: string[] = [];
          for (const subnetItem of tgwAttachmentItem.subnets ?? []) {
            const subnet = subnetMap.get(subnetItem);
            if (subnet === undefined) {
              throw new Error(`Subnet ${subnetItem} not defined`);
            }
            subnetIds.push(subnet.subnetId);
          }

          const attachment = new TransitGatewayAttachment(
            this,
            pascalCase(`${tgwAttachmentItem.name}VpcTransitGatewayAttachment`),
            {
              name: tgwAttachmentItem.name,
              transitGatewayId,
              subnetIds,
              vpcId: vpc.vpcId,
            },
          );
          transitGatewayAttachments.set(tgwAttachmentItem.transitGateway.name, attachment);
          new ssm.StringParameter(
            this,
            pascalCase(
              `SsmParam${pascalCase(vpcItem.name) + pascalCase(tgwAttachmentItem.name)}TransitGatewayAttachmentId`,
            ),
            {
              parameterName: `/accelerator/network/vpc/${vpcItem.name}/transitGatewayAttachment/${tgwAttachmentItem.name}/id`,
              stringValue: attachment.transitGatewayAttachmentId,
            },
          );
        }

        //
        // Create Route Table Entries. Also keep track of gateway endpoint
        // service targets to pass when making the Gateway VPC Endpoints
        //
        const s3EndpointRouteTables: string[] = [];
        const dynamodbEndpointRouteTables: string[] = [];
        for (const routeTableItem of vpcItem.routeTables ?? []) {
          const routeTable = routeTableMap.get(routeTableItem.name);

          if (routeTable === undefined) {
            throw new Error(`Route Table ${routeTableItem.name} not found`);
          }

          for (const routeTableEntryItem of routeTableItem.routes ?? []) {
            const id =
              pascalCase(`${vpcItem.name}Vpc`) +
              pascalCase(`${routeTableItem.name}RouteTable`) +
              pascalCase(routeTableEntryItem.name);

            if (routeTableEntryItem.type === 'transitGateway') {
              console.log(`Adding Transit Gateway Route Table Entry ${routeTableEntryItem.name}`);

              const transitGatewayId = transitGatewayIds.get(routeTableEntryItem.target);
              if (transitGatewayId === undefined) {
                throw new Error(`Transit Gateway ${routeTableEntryItem.target} not found`);
              }

              const transitGatewayAttachment = transitGatewayAttachments.get(routeTableEntryItem.target);
              if (transitGatewayAttachment === undefined) {
                throw new Error(`Transit Gateway Attachment ${routeTableEntryItem.target} not found`);
              }

              routeTable.addTransitGatewayRoute(
                id,
                routeTableEntryItem.destination,
                transitGatewayId,
                // TODO: Implement correct dependency relationships without need for escape hatch
                transitGatewayAttachment.node.defaultChild as ec2.CfnTransitGatewayAttachment,
              );
            } else if (routeTableEntryItem.type === 'natGateway') {
              console.log(`Adding NAT Gateway Route Table Entry ${routeTableEntryItem.name}`);

              const natGateway = natGatewayMap.get(routeTableEntryItem.target);
              if (natGateway === undefined) {
                throw new Error(`NAT Gateway ${routeTableEntryItem.target} not found`);
              }

              routeTable.addNatGatewayRoute(id, routeTableEntryItem.destination, natGateway.natGatewayId);
            } else if (routeTableEntryItem.type === 'internetGateway') {
              console.log(`Adding Internet Gateway Route Table Entry ${routeTableEntryItem.name}`);
              routeTable.addInternetGatewayRoute(id, routeTableEntryItem.destination);
            } else if (routeTableEntryItem.target === 's3') {
              if (s3EndpointRouteTables.indexOf(routeTable.routeTableId) == -1) {
                s3EndpointRouteTables.push(routeTable.routeTableId);
              }
            } else if (routeTableEntryItem.target === 'dynamodb') {
              if (dynamodbEndpointRouteTables.indexOf(routeTable.routeTableId) == -1) {
                dynamodbEndpointRouteTables.push(routeTable.routeTableId);
              }
            }
          }
        }

        //
        // Add Gateway Endpoints (AWS Services)
        //
        for (const gatewayEndpointItem of vpcItem.gatewayEndpoints ?? []) {
          console.log(`Adding Gateway Endpoint for ${gatewayEndpointItem}`);

          if (gatewayEndpointItem === 's3') {
            vpc.addGatewayVpcEndpoint(
              pascalCase(`${vpcItem.name}Vpc`) + pascalCase(gatewayEndpointItem),
              gatewayEndpointItem,
              s3EndpointRouteTables,
            );
          } else if (gatewayEndpointItem === 'dynamodb') {
            vpc.addGatewayVpcEndpoint(
              pascalCase(`${vpcItem.name}Vpc`) + pascalCase(gatewayEndpointItem),
              gatewayEndpointItem,
              dynamodbEndpointRouteTables,
            );
          }
        }

        //
        // TODO: Add Security Groups
        //

        //
        // TODO: Service Endpoints (local eni ssm.amazonaws.com)
        //
      }
    }
  }
}
