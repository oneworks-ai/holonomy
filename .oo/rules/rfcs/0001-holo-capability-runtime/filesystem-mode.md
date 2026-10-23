# RFC-0001 附录 H.3：Filesystem Mode

[返回 FS Metadata](filesystem-metadata-and-durability.md)

MODE 是独立的新权限，不由已有 write、read 或持有 FD 隐含获得。旧 Policy 不含 `chmod` 时，规范化结果和 digest 不改变。Root 显式授予第八项 right `chmod` 后，每次操作重新通过 Policy、Host Middleware 与 Provider；不是把 metadata 权限偷放进 open。data FD 权限保持原样，readonly FD 有另行批准的 chmod 权时可修改 mode，但仍不能写数据或 truncate。

| Module/member           | Mode     | Args / result                                         | Operation/right                   | callback |
| ----------------------- | -------- | ----------------------------------------------------- | --------------------------------- | -------- |
| fs/chmodSync            | sync     | FsChmodArgsV1 / void                                  | filesystem.metadata.chmod / chmod | —        |
| fs/chmod                | callback | FsChmodArgsV1 / void                                  | filesystem.metadata.chmod / chmod | void     |
| fs/promises/chmod       | promise  | FsChmodPromiseArgsV1 / FsChmodMutationResultV1        | filesystem.metadata.chmod / chmod | —        |
| fs/fchmodSync           | sync     | FsFchmodArgsV1 / void                                 | filesystem.metadata.chmod / chmod | —        |
| fs/fchmod               | callback | FsFchmodArgsV1 / void                                 | filesystem.metadata.chmod / chmod | void     |
| FileHandle/chmod        | promise  | FsHandleChmodPromiseArgsV1 / FsChmodMutationResultV1  | filesystem.metadata.chmod / chmod | —        |
| host.fs/directory.chmod | promise  | FsHandleChmodReadbackArgsV1 / FsChmodMetadataResultV1 | filesystem.metadata.chmod / chmod | —        |

```ts
type FsModeInputV1 = number | string
interface FsChmodArgsV1 {
  readonly path: VirtualPathV1
  readonly mode: number
}
interface FsChmodReadbackArgsV1 extends FsChmodArgsV1 {
  readonly readback: true
  readonly expectedKind?: 'file' | 'directory'
}
type FsChmodPromiseArgsV1 =
  | FsChmodArgsV1
  | FsChmodReadbackArgsV1
interface FsHandleChmodArgsV1 {
  readonly mode: number
}
interface FsFchmodArgsV1 extends FsHandleChmodArgsV1 {
  readonly fd: number
}
interface FsHandleChmodReadbackArgsV1 extends FsHandleChmodArgsV1 {
  readonly readback: true
  readonly expectedKind?: 'file' | 'directory'
}
type FsHandleChmodPromiseArgsV1 =
  | FsHandleChmodArgsV1
  | FsHandleChmodReadbackArgsV1
interface FsChmodMetadataResultV1
  extends Omit<FsExactMetadataResultV1, 'kind'>
{
  readonly kind: 'file' | 'directory'
  readonly mode: number
}
type FsChmodMutationResultV1 =
  | EmptyArgsV1
  | FsChmodMetadataResultV1
```

public mode仅primitive数字或严格八进制字符串，经Guest facade归一成整数0..0777。NaN/Infinity/负数、小数、超界、object/Proxy与special/filetype bits拒绝，不调用Guest coercion。此增量不支持setuid、setgid、sticky、chown或通过mode授予execution。virtual fd必须先解析到Kernel opaque binding，不能作为native fd；mode改0再通过原FD恢复权限应保持对象identity。

Raw args/普通结果strict，callback成功精确一参null、失败一参Error，Promise成功undefined。只有认证Linux source的readback branch可返回完整 `FsChmodMetadataResultV1`；其mode必须是实际type|perm，file为0100000..0100777，directory为0040000..0040777，且与kind一致。普通Stat的mode为可选number以兼容未升级Provider；Node/Native实现真实提供，普通Guest Stats可投影标准mode，不引入Ns字符串。

typed Linux MODE携带的expectedKind只可放入认证Linux-only readback arguments，public strict branch拒绝该field。Node/Native在最终pinned/retained FD上验证实际kind后才fchmod，不能修改后才依赖结果schema报错。FUSE inode cache可提前拒绝，但不替代此权威检查；不通过providerData或额外path stat重开绕过。

FUSE MODE字段在pinned Linux `fuse_setattr_in` 的byte68，body88bytes；unused4在72。仅纯MODE与可选FH，先验证其余reserved/unused字段与mask。mode可带0/已知REG/DIR type bits；只将perm传Provider，不能改变inode类型。FH存在时使用原file/directory binding，禁止退化到path。SIZE/time/uid/gid/ctime等混合形态与special bits在任何effect前整单拒绝。

getattr/lookup/create/mkdir/setattr的mode来自实际stat，不硬编码0644/0755；FUSE UID/GID仍是虚拟映射，不泄露Host身份。mode与kind/type不一致的结果校验失败。已存在Host对象的特殊mode可按stat真实呈现，但新chmod操作不能设置special bits；Linux mount/process ceiling仍独立约束execution。

path mutation使用安全打开的descriptor、withinRoot ticket与identity复验；不可用fchmodat裸路径替代原inode。macOS对mode000且无可安全打开FD的path可能保守拒绝，此状态仍为partial；已有FD可恢复mode000。取消、Host拒绝、错误snapshot或publication不能新发布资源或增加权限。Host-only directory row只向认证Linux source开放，但使用新鲜chmod selection，不是继承原list权来修改mode。

vectors应覆盖write无chmod默认拒绝、readonly FD另授权、特殊位/类型位/Proxy零副作用、MODE68真实Git帧、FH原inode、目录kind一致、callback一参、mode000经FD恢复、OS实际mode与内容不变、Host拒绝零effect以及chmod+x仍无execution。Git init/status必须经真实Guest命令验收；不能用MODE no-op或跳过Git断言宣称支持。
