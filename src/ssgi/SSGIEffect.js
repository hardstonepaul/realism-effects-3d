﻿/* eslint-disable camelcase */
import { Effect, RenderPass, Selection } from "postprocessing"
import {
	EquirectangularReflectionMapping,
	LinearMipMapLinearFilter,
	NoToneMapping,
	sRGBEncoding,
	Uniform,
	WebGLRenderTarget
} from "three"
import { SVGF } from "../svgf/SVGF.js"
import { SSGIPass } from "./pass/SSGIPass.js"
import compose from "./shader/compose.frag"
import denoise_compose from "./shader/denoise_compose.frag"
import denoise_compose_functions from "./shader/denoise_compose_functions.glsl"
import { defaultSSGIOptions } from "./SSGIOptions"
import {
	createGlobalDisableIblIradianceUniform,
	createGlobalDisableIblRadianceUniform,
	getMaxMipLevel,
	getVisibleChildren,
	splitIntoGroupsOfVector4
} from "./utils/Utils.js"

import initWasm, { calculate_bins } from "./wasm/envmap_importance_sample_wasm"
let didInitWasm = false

const { render } = RenderPass.prototype

const globalIblIrradianceDisabledUniform = createGlobalDisableIblIradianceUniform()
const globalIblRadianceDisabledUniform = createGlobalDisableIblRadianceUniform()

export class SSGIEffect extends Effect {
	selection = new Selection()
	isUsingRenderPass = true

	/**
	 * @param {THREE.Scene} scene The scene of the SSGI effect
	 * @param {THREE.Camera} camera The camera with which SSGI is being rendered
	 * @param {VelocityPass} velocityPass Required velocity pass
	 * @param {SSGIOptions} [options] The optional options for the SSGI effect
	 */
	constructor(scene, camera, velocityPass, options = defaultSSGIOptions) {
		options = { ...defaultSSGIOptions, ...options }

		super("SSGIEffect", compose, {
			type: "FinalSSGIMaterial",
			uniforms: new Map([
				["inputTexture", new Uniform(null)],
				["sceneTexture", new Uniform(null)],
				["depthTexture", new Uniform(null)],
				["toneMapping", new Uniform(NoToneMapping)]
			])
		})

		this._scene = scene
		this._camera = camera

		let definesName
		let specularIndex = -1

		if (options.diffuseOnly) {
			definesName = "ssdgi"
			options.reprojectSpecular = false
			options.catmullRomSampling = false
			options.roughnessDependentKernel = false
		} else if (options.specularOnly) {
			definesName = "ssr"
			options.reprojectSpecular = true
			options.catmullRomSampling = true
			options.roughnessDependentKernel = true
		} else {
			definesName = "ssgi"
			options.reprojectSpecular = [false, true]
			options.catmullRomSampling = [false, true]
			options.roughnessDependentKernel = [false, true]
			specularIndex = 1
		}

		const textureCount = options.diffuseOnly || options.specularOnly ? 1 : 2

		this.svgf = new SVGF(scene, camera, velocityPass, textureCount, denoise_compose, denoise_compose_functions, options)

		if (specularIndex !== -1) {
			this.svgf.svgfTemporalReprojectPass.fullscreenMaterial.fragmentShader =
				this.svgf.svgfTemporalReprojectPass.fullscreenMaterial.fragmentShader.replace(
					`outputColor = mix(inputTexel[ ${specularIndex} ].rgb, accumulatedTexel[ ${specularIndex} ].rgb, temporalReprojectMix);`,
					/* glsl */ `
					float roughness = inputTexel[0].a;
					float glossines = max(0., 0.025 - roughness) / 0.025;
					temporalReprojectMix *= 1. - glossines * glossines;
					
					outputColor = mix(inputTexel[ ${specularIndex} ].rgb, accumulatedTexel[ ${specularIndex} ].rgb, temporalReprojectMix);
					`
				)
		}

		this.svgf.svgfTemporalReprojectPass.fullscreenMaterial.needsUpdate = true

		// ssgi pass
		this.ssgiPass = new SSGIPass(this, options)

		if (options.diffuseOnly) {
			this.svgf.svgfTemporalReprojectPass.fullscreenMaterial.uniforms.inputTexture0.value = this.ssgiPass.texture
		} else if (options.specularOnly) {
			this.svgf.svgfTemporalReprojectPass.fullscreenMaterial.uniforms.inputTexture0.value =
				this.ssgiPass.specularTexture
		} else {
			this.svgf.svgfTemporalReprojectPass.fullscreenMaterial.uniforms.inputTexture0.value = this.ssgiPass.texture
			this.svgf.svgfTemporalReprojectPass.fullscreenMaterial.uniforms.inputTexture1.value =
				this.ssgiPass.specularTexture
		}

		// the denoiser always uses the same G-buffers as the SSGI pass
		const denoisePassUniforms = this.svgf.denoisePass.fullscreenMaterial.uniforms
		denoisePassUniforms.depthTexture.value = this.ssgiPass.depthTexture
		denoisePassUniforms.normalTexture.value = this.ssgiPass.normalTexture

		this.svgf.setJitteredGBuffers(this.ssgiPass.depthTexture, this.ssgiPass.normalTexture)

		// patch the denoise pass
		this.svgf.denoisePass.fullscreenMaterial.uniforms = {
			...this.svgf.denoisePass.fullscreenMaterial.uniforms,
			...{
				diffuseTexture: new Uniform(null),
				directLightTexture: new Uniform(null)
			}
		}

		this.svgf.denoisePass.fullscreenMaterial.defines[definesName] = ""

		this.ssgiPass.fullscreenMaterial.defines.directLightMultiplier = options.directLightMultiplier.toPrecision(5)

		this.svgf.denoisePass.fullscreenMaterial.uniforms.diffuseTexture.value = this.ssgiPass.diffuseTexture

		this.lastSize = {
			width: options.width,
			height: options.height,
			resolutionScale: options.resolutionScale
		}

		this.sceneRenderTarget = new WebGLRenderTarget(1, 1, {
			encoding: sRGBEncoding
		})

		this.setSize(options.width, options.height)

		const th = this
		RenderPass.prototype.render = function(...args) {
			const wasUsingRenderPass = th.isUsingRenderPass
			th.isUsingRenderPass = true

			if (wasUsingRenderPass != th.isUsingRenderPass) th.updateUsingRenderPass()

			render.call(this, ...args)
		}

		this.makeOptionsReactive(options)
	}

	updateUsingRenderPass() {
		if (this.isUsingRenderPass) {
			this.ssgiPass.fullscreenMaterial.defines.useDirectLight = ""
			this.svgf.denoisePass.fullscreenMaterial.defines.useDirectLight = ""
		} else {
			delete this.ssgiPass.fullscreenMaterial.defines.useDirectLight
			delete this.svgf.denoisePass.fullscreenMaterial.defines.useDirectLight
		}

		this.ssgiPass.fullscreenMaterial.needsUpdate = true
		this.svgf.denoisePass.fullscreenMaterial.needsUpdate = true
	}

	makeOptionsReactive(options) {
		let needsUpdate = false

		if (options.reflectionsOnly) this.svgf.svgfTemporalReprojectPass.fullscreenMaterial.defines.reflectionsOnly = ""

		const ssgiPassFullscreenMaterialUniforms = this.ssgiPass.fullscreenMaterial.uniforms
		const ssgiPassFullscreenMaterialUniformsKeys = Object.keys(ssgiPassFullscreenMaterialUniforms)

		for (const key of Object.keys(options)) {
			Object.defineProperty(this, key, {
				get() {
					return options[key]
				},
				set(value) {
					if (options[key] === value && needsUpdate) return

					options[key] = value

					switch (key) {
						case "resolutionScale":
							this.setSize(this.lastSize.width, this.lastSize.height)
							break

						case "denoiseIterations":
							this.svgf.denoisePass.iterations = value
							break

						case "denoiseDiffuse":
							this.svgf.denoisePass.fullscreenMaterial.uniforms.denoise.value[0] = value
							break

						case "denoiseSpecular":
							this.svgf.denoisePass.fullscreenMaterial.uniforms.denoise.value[1] = value
							break

						case "denoiseKernel":
						case "depthPhi":
						case "normalPhi":
						case "roughnessPhi":
							this.svgf.denoisePass.fullscreenMaterial.uniforms[key].value = value
							break

						// defines
						case "steps":
						case "refineSteps":
						case "spp":
							this.ssgiPass.fullscreenMaterial.defines[key] = parseInt(value)
							this.ssgiPass.fullscreenMaterial.needsUpdate = needsUpdate
							break

						case "missedRays":
						case "autoThickness":
							if (value) {
								this.ssgiPass.fullscreenMaterial.defines[key] = ""
							} else {
								delete this.ssgiPass.fullscreenMaterial.defines[key]
							}

							this.ssgiPass.fullscreenMaterial.needsUpdate = needsUpdate
							break

						case "correctionRadius":
							this.svgf.svgfTemporalReprojectPass.fullscreenMaterial.defines[key] = Math.round(value)

							this.svgf.svgfTemporalReprojectPass.fullscreenMaterial.needsUpdate = needsUpdate
							break

						case "blend":
						case "correction":
							this.svgf.svgfTemporalReprojectPass.fullscreenMaterial.uniforms[key].value = value
							break

						case "distance":
							ssgiPassFullscreenMaterialUniforms.rayDistance.value = value
							break

						// must be a uniform
						default:
							if (ssgiPassFullscreenMaterialUniformsKeys.includes(key)) {
								ssgiPassFullscreenMaterialUniforms[key].value = value
							}
					}
				}
			})

			// apply all uniforms and defines
			this[key] = options[key]
		}

		needsUpdate = true
	}

	initialize(renderer, ...args) {
		super.initialize(renderer, ...args)
		this.ssgiPass.initialize(renderer, ...args)
	}

	setSize(width, height, force = false) {
		if (width === undefined && height === undefined) return
		if (
			!force &&
			width === this.lastSize.width &&
			height === this.lastSize.height &&
			this.resolutionScale === this.lastSize.resolutionScale
		)
			return

		this.ssgiPass.setSize(width, height)
		this.svgf.setSize(width, height)
		this.sceneRenderTarget.setSize(width, height)

		this.lastSize = {
			width,
			height,
			resolutionScale: this.resolutionScale
		}
	}

	setVelocityPass(velocityPass) {
		this.ssgiPass.fullscreenMaterial.uniforms.velocityTexture.value = velocityPass.texture
		this.svgf.svgfTemporalReprojectPass.fullscreenMaterial.uniforms.velocityTexture.value = velocityPass.texture

		this.svgf.setNonJitteredGBuffers(velocityPass.depthTexture, velocityPass.normalTexture)
	}

	dispose() {
		super.dispose()

		this.ssgiPass.dispose()
		this.svgf.dispose()

		RenderPass.prototype.render = render
	}

	keepEnvMapUpdated() {
		const ssgiMaterial = this.ssgiPass.fullscreenMaterial

		if (ssgiMaterial.uniforms.envMap.value !== this._scene.environment) {
			if (this._scene.environment?.mapping === EquirectangularReflectionMapping) {
				ssgiMaterial.uniforms.envMap.value = this._scene.environment

				if (!this._scene.environment.generateMipmaps) {
					this._scene.environment.generateMipmaps = true
					this._scene.environment.minFilter = LinearMipMapLinearFilter
					this._scene.environment.magFilter = LinearMipMapLinearFilter
					this._scene.environment.needsUpdate = true
				}

				const maxEnvMapMipLevel = getMaxMipLevel(this._scene.environment)
				ssgiMaterial.uniforms.maxEnvMapMipLevel.value = maxEnvMapMipLevel

				const { width, height, data } = this._scene.environment.image
				ssgiMaterial.uniforms.envSize.value.set(width, height)

				ssgiMaterial.defines.USE_ENVMAP = ""

				const createBins = () => {
					let dataArr = []

					const luminanceSq = (r, g, b) => (r * 0.2125 + g * 0.7154 + b * 0.0721) ** 2

					let index = 0
					let avgLum = 0
					for (let i = 0; i < data.length; i += 4) {
						avgLum += luminanceSq(
							(dataArr[index++] = data[i]),
							(dataArr[index++] = data[i + 1]),
							(dataArr[index++] = data[i + 2])
						)
					}

					avgLum /= width * height

					console.log(avgLum)

					const now = performance.now()
					dataArr = new Float32Array(dataArr)
					let bins = calculate_bins(dataArr, width, height, 10000 * avgLum, 64 ** 2)

					const time = performance.now() - now

					bins = splitIntoGroupsOfVector4(Array.from(bins))

					ssgiMaterial.uniforms.bins.value = bins
					ssgiMaterial.defines.numBins = bins.length

					console.log("bins", bins, "time", time.toFixed(2) + " ms")

					ssgiMaterial.needsUpdate = true
				}

				// create bins from the env map for importance sampling
				if (didInitWasm) {
					createBins()
				} else {
					initWasm().then(createBins)
					didInitWasm = true
				}
			} else {
				ssgiMaterial.uniforms.envMap.value = null
				delete ssgiMaterial.defines.USE_ENVMAP
			}

			ssgiMaterial.needsUpdate = true
		}
	}

	update(renderer, inputBuffer) {
		// ! todo: make SSGI's accumulation no longer FPS-dependent

		this.keepEnvMapUpdated()

		const sceneBuffer = this.isUsingRenderPass ? inputBuffer : this.sceneRenderTarget

		const hideMeshes = []

		if (!this.isUsingRenderPass) {
			renderer.setRenderTarget(this.sceneRenderTarget)

			const children = []

			for (const c of getVisibleChildren(this._scene)) {
				if (c.isScene) return

				const originalMaterial = c.material

				c.visible = !(
					originalMaterial.visible &&
					originalMaterial.depthWrite &&
					originalMaterial.depthTest &&
					c.constructor.name !== "GroundProjectedEnv"
				)

				c.visible ? hideMeshes.push(c) : children.push(c)
			}

			renderer.render(this._scene, this._camera)

			for (const c of children) c.visible = true
			for (const c of hideMeshes) c.visible = false
		}

		this.ssgiPass.fullscreenMaterial.uniforms.directLightTexture.value = sceneBuffer.texture
		this.svgf.denoisePass.fullscreenMaterial.uniforms.directLightTexture.value = sceneBuffer.texture

		this.ssgiPass.render(renderer)
		this.svgf.render(renderer)

		this.uniforms.get("inputTexture").value = this.svgf.texture
		this.uniforms.get("sceneTexture").value = sceneBuffer.texture
		this.uniforms.get("depthTexture").value = this.ssgiPass.depthTexture
		this.uniforms.get("toneMapping").value = renderer.toneMapping

		for (const c of hideMeshes) c.visible = true

		const fullGi = !this.diffuseOnly && !this.specularOnly

		globalIblIrradianceDisabledUniform.value = fullGi || this.diffuseOnly === true
		globalIblRadianceDisabledUniform.value = fullGi || this.specularOnly == true

		cancelAnimationFrame(this.rAF2)
		cancelAnimationFrame(this.rAF)
		cancelAnimationFrame(this.usingRenderPassRAF)

		this.rAF = requestAnimationFrame(() => {
			this.rAF2 = requestAnimationFrame(() => {
				globalIblIrradianceDisabledUniform.value = false
				globalIblRadianceDisabledUniform.value = false
			})
		})
		this.usingRenderPassRAF = requestAnimationFrame(() => {
			const wasUsingRenderPass = this.isUsingRenderPass
			this.isUsingRenderPass = false

			if (wasUsingRenderPass != this.isUsingRenderPass) this.updateUsingRenderPass()
		})
	}
}
