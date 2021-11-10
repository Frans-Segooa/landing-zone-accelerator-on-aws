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

import * as ec2 from '@aws-cdk/aws-ec2';
import * as core from '@aws-cdk/core';

export interface ISecureRouteTable extends core.IResource {
  /**
   * The identifier of the route table
   *
   * @attribute
   */
  readonly secureRouteTableId: string;

  /**
   * The VPC associated with the route table
   *
   * @attribute
   */
  readonly vpc: ISecureVpc;
}

export interface SecureRouteTableProps {
  readonly name: string;
  readonly vpc: ISecureVpc;
}

export class SecureRouteTable extends core.Resource implements ISecureRouteTable {
  public readonly secureRouteTableId: string;

  public readonly vpc: ISecureVpc;

  constructor(scope: core.Construct, id: string, props: SecureRouteTableProps) {
    super(scope, id);

    this.vpc = props.vpc;

    const resource = new ec2.CfnRouteTable(this, 'Resource', {
      vpcId: props.vpc.secureVpcId,
      tags: [{ key: 'Name', value: props.name }],
    });

    this.secureRouteTableId = resource.ref;
  }

  public addTransitGatewayRoute(
    id: string,
    destination: string,
    transitGatewayId: string,
    transitGatewayAttachment: core.CfnResource,
  ): void {
    const route = new ec2.CfnRoute(this, id, {
      routeTableId: this.secureRouteTableId,
      destinationCidrBlock: destination,
      transitGatewayId: transitGatewayId,
    });
    route.addDependsOn(transitGatewayAttachment);
  }

  public addNatGatewayRoute(id: string, destination: string, natGatewayId: string): void {
    new ec2.CfnRoute(this, id, {
      routeTableId: this.secureRouteTableId,
      destinationCidrBlock: destination,
      natGatewayId: natGatewayId,
    });
  }

  public addInternetGatewayRoute(id: string, destination: string): void {
    if (!this.vpc.internetGatewayId) {
      throw new Error('Attempting to add Internet Gateway route without an IGW defined.');
    }

    new ec2.CfnRoute(this, id, {
      routeTableId: this.secureRouteTableId,
      destinationCidrBlock: destination,
      gatewayId: this.vpc.internetGatewayId,
    });
  }
}

export interface ISecureSubnet extends core.IResource {
  /**
   * The identifier of the subnet
   *
   * @attribute
   */
  readonly subnetId: string;

  /**
   * The name of the subnet
   *
   * @attribute
   */
  readonly subnetName: string;

  /**
   * The Availability Zone the subnet is located in
   *
   * @attribute
   */
  readonly availabilityZone: string;

  // /**
  //  * The VPC associated with the subnet
  //  *
  //  * @attribute
  //  */
  // readonly routeTable: ISecureRouteTable;

  //  /**
  //   * The route table for this subnet
  //   */
  //  readonly routeTable: IRouteTable;

  //  /**
  //   * Associate a Network ACL with this subnet
  //   *
  //   * @param acl The Network ACL to associate
  //   */
  //  associateNetworkAcl(id: string, acl: INetworkAcl): void;

  // /**
  //  * The IPv4 CIDR block for this subnet
  //  */
  //  readonly ipv4CidrBlock: string;

  //  readonly mapPublicIpOnLaunch: boolean;
}

export interface SecureSubnetProps {
  readonly name: string;
  readonly availabilityZone: string;
  readonly ipv4CidrBlock: string;
  readonly mapPublicIpOnLaunch?: boolean;
  readonly routeTable: ISecureRouteTable;
  readonly vpc: ISecureVpc;
  // readonly nacl: ISecureNacl;
}

export class SecureSubnet extends core.Resource implements ISecureSubnet {
  public readonly subnetName: string;
  public readonly availabilityZone: string;
  public readonly ipv4CidrBlock: string;
  public readonly mapPublicIpOnLaunch?: boolean;
  public readonly routeTable: ISecureRouteTable;
  public readonly subnetId: string;

  constructor(scope: core.Construct, id: string, props: SecureSubnetProps) {
    super(scope, id);

    this.subnetName = props.name;
    this.availabilityZone = props.availabilityZone;
    this.ipv4CidrBlock = props.ipv4CidrBlock;
    this.mapPublicIpOnLaunch = props.mapPublicIpOnLaunch;
    this.routeTable = props.routeTable;

    const resource = new ec2.CfnSubnet(this, 'Resource', {
      vpcId: props.vpc.secureVpcId,
      cidrBlock: props.ipv4CidrBlock,
      availabilityZone: props.availabilityZone,
      mapPublicIpOnLaunch: props.mapPublicIpOnLaunch,
      tags: [{ key: 'Name', value: props.name }],
    });

    this.subnetId = resource.ref;

    new ec2.CfnSubnetRouteTableAssociation(this, 'RouteTableAssociation', {
      subnetId: this.subnetId,
      routeTableId: props.routeTable.secureRouteTableId,
    });
  }
}

export interface ISecureNatGateway extends core.IResource {
  /**
   * The identifier of the NAT Gateway
   *
   * @attribute
   */
  readonly natGatewayId: string;

  /**
   * The name of the NAT Gateway
   *
   * @attribute
   */
  readonly natGatewayName: string;
}

export interface SecureNatGatewayProps {
  readonly name: string;
  readonly subnet: ISecureSubnet;
}

export class SecureNatGateway extends core.Resource implements ISecureNatGateway {
  public readonly natGatewayId: string;
  public readonly natGatewayName: string;

  constructor(scope: core.Construct, id: string, props: SecureNatGatewayProps) {
    super(scope, id);

    this.natGatewayName = props.name;

    const resource = new ec2.CfnNatGateway(this, 'Resource', {
      subnetId: props.subnet.subnetId,
      allocationId: new ec2.CfnEIP(this, 'Eip', {
        domain: 'vpc',
      }).attrAllocationId,
      tags: [{ key: 'Name', value: props.name }],
    });

    this.natGatewayId = resource.ref;
  }
}

export interface ISecureVpc extends core.IResource {
  /**
   * The identifier of the vpc
   *
   * @attribute
   */
  readonly secureVpcId: string;

  /**
   * The Internet Gateway Id
   */
  readonly internetGatewayId?: string;
}

/**
 * Construction properties for a Secure VPC object.
 */
export interface SecureVpcProps {
  readonly name: string;
  readonly ipv4CidrBlock: string;
  readonly enableDnsHostnames?: boolean;
  readonly enableDnsSupport?: boolean;
  readonly instanceTenancy?: ec2.DefaultInstanceTenancy;
  readonly internetGateway?: boolean;
}

/**
 * Defines a Secure S3 Bucket object. By default a KMS CMK is generated and
 * associated to the bucket.
 */
export class SecureVpc extends core.Resource implements ISecureVpc {
  // private readonly vpc: ec2.CfnVPC;

  public readonly secureVpcId: string;
  public readonly internetGatewayId: string | undefined;

  constructor(scope: core.Construct, id: string, props: SecureVpcProps) {
    super(scope, id);

    const resource = new ec2.CfnVPC(this, 'Resource', {
      cidrBlock: props.ipv4CidrBlock,
      enableDnsHostnames: props.enableDnsHostnames,
      enableDnsSupport: props.enableDnsSupport,
      instanceTenancy: props.instanceTenancy,
      tags: [{ key: 'Name', value: props.name }],
    });

    this.secureVpcId = resource.ref;

    if (props.internetGateway) {
      const igw = new ec2.CfnInternetGateway(this, 'InternetGateway', {});

      new ec2.CfnVPCGatewayAttachment(this, 'InternetGatewayAttachment', {
        internetGatewayId: igw.ref,
        vpcId: this.secureVpcId,
      });

      this.internetGatewayId = igw.ref;
    }
  }

  public addGatewayVpcEndpoint(id: string, service: string, routeTableIds: string[]): void {
    // const gwService = ;
    new ec2.CfnVPCEndpoint(this, id, {
      serviceName: new ec2.GatewayVpcEndpointAwsService(service).name,
      vpcId: this.secureVpcId,
      routeTableIds,
    });
  }

  // public getVpc(): ec2.CfnVPC {
  //   return this.vpc;
  // }
}
